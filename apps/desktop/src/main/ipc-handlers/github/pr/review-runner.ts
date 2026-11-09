/**
 * PR review runner: fetches PR context from GitHub and runs the TypeScript reviewer.
 */

import type { BrowserWindow } from "electron";
import { IPC_CHANNELS } from "../../../../shared/constants";
import { getGitHubConfig, githubFetch } from "../utils";
import { getAugmentedEnv } from "../../../env-utils";
import type { Project } from "../../../../shared/types";
import { createIPCCommunicators } from "../utils/ipc-communicator";
import {
  type PRContext,
  type ChangedFile,
  type AIBotComment,
} from "../../../ai/runners/github/pr-review-engine";
import {
  ParallelOrchestratorReviewer,
  type ParallelOrchestratorConfig,
} from "../../../ai/runners/github/parallel-orchestrator";
import type { ModelShorthand, ThinkingLevel } from "../../../ai/config/types";
import { safeBreadcrumb, safeCaptureException } from "../../../sentry";
import { checkoutNoteFor, preparePRReviewCheckout, type PRReviewCheckout } from "../../../ai/runners/github/pr-review-checkout";
import { createPRReviewMcpSession, type PRReviewMcpSession } from "../../../ai/runners/github/pr-review-mcp";
import type { PRReviewFinding, PRReviewResult, PRReviewProgress } from "./types";
import { debugLog, runningReviews, getReviewKey } from "./shared";
import { PRLogCollector } from "./review-logs";
import {
  getGitHubPRSettings,
  saveReviewResultToDisk,
  savePRReviewToMemory,
} from "./review-results";

/**
 * Fetch complete PR context from GitHub API for TypeScript review engine.
 */
export async function fetchPRContext(
  config: { token: string; repo: string },
  prNumber: number
): Promise<PRContext> {
  // Fetch PR metadata
  const pr = (await githubFetch(
    config.token,
    `/repos/${config.repo}/pulls/${prNumber}`
  )) as {
    number: number;
    title: string;
    body?: string;
    state: string;
    user: { login: string };
    head: { ref: string; sha: string };
    base: { ref: string };
    additions: number;
    deletions: number;
    labels?: Array<{ name: string }>;
  };

  // Fetch files with patches
  const files = (await githubFetch(
    config.token,
    `/repos/${config.repo}/pulls/${prNumber}/files?per_page=100`
  )) as Array<{
    filename: string;
    additions: number;
    deletions: number;
    status: string;
    patch?: string;
  }>;

  // Fetch commits
  const commits = (await githubFetch(
    config.token,
    `/repos/${config.repo}/pulls/${prNumber}/commits?per_page=100`
  )) as Array<{
    sha: string;
    commit: { message: string; committer?: { date?: string } };
  }>;

  // Fetch diff (for full diff context)
  let diff = "";
  let diffTruncated = false;
  try {
    const { execFileSync } = await import("child_process");
    if (Number.isInteger(prNumber) && prNumber > 0) {
      const rawDiff = execFileSync("gh", ["pr", "diff", String(prNumber)], {
        cwd: config.repo.split("/")[1] ? undefined : undefined,
        encoding: "utf-8",
        env: getAugmentedEnv(),
        timeout: 30000,
      });
      if (rawDiff.length > 200000) {
        diff = rawDiff.slice(0, 200000);
        diffTruncated = true;
      } else {
        diff = rawDiff;
      }
    }
  } catch {
    // If gh CLI fails, build diff from patches
    diff = files
      .filter((f) => f.patch)
      .map((f) => `diff --git a/${f.filename} b/${f.filename}\n${f.patch}`)
      .join("\n");
  }

  // Fetch AI bot comments (review comments from known AI tools)
  let aiBotComments: AIBotComment[] = [];
  try {
    const reviewComments = (await githubFetch(
      config.token,
      `/repos/${config.repo}/pulls/${prNumber}/comments?per_page=100`
    )) as Array<{
      id: number;
      user: { login: string };
      body: string;
      path?: string;
      line?: number;
      created_at: string;
    }>;

    const AI_BOTS = ["coderabbitai", "cursor-ai", "greptile", "sourcery-ai", "codeflash-ai"];
    aiBotComments = reviewComments
      .filter((c) => AI_BOTS.some((bot) => c.user.login.toLowerCase().includes(bot)))
      .map((c) => ({
        commentId: c.id,
        author: c.user.login,
        toolName: AI_BOTS.find((bot) => c.user.login.toLowerCase().includes(bot)) ?? c.user.login,
        body: c.body,
        file: c.path,
        line: c.line,
        createdAt: c.created_at,
      }));
  } catch {
    // Non-critical — continue without bot comments
  }

  const changedFiles: ChangedFile[] = files.map((f) => ({
    path: f.filename,
    additions: f.additions,
    deletions: f.deletions,
    status: f.status,
    patch: f.patch,
  }));

  return {
    prNumber: pr.number,
    title: pr.title,
    description: pr.body ?? "",
    author: pr.user.login,
    baseBranch: pr.base.ref,
    headBranch: pr.head.ref,
    state: pr.state,
    changedFiles,
    diff,
    diffTruncated,
    repoStructure: "",
    relatedFiles: [],
    commits: commits.map((c) => ({
      oid: c.sha,
      messageHeadline: c.commit.message.split("\n")[0] ?? "",
      committedDate: c.commit.committer?.date ?? "",
    })),
    labels: pr.labels?.map((l) => l.name) ?? [],
    totalAdditions: pr.additions,
    totalDeletions: pr.deletions,
    aiBotComments,
  };
}

/**
 * Run the TypeScript PR reviewer
 */
export async function runPRReview(
  project: Project,
  prNumber: number,
  mainWindow: BrowserWindow
): Promise<PRReviewResult> {
  const { sendProgress } = createIPCCommunicators<PRReviewProgress, PRReviewResult>(
    mainWindow,
    {
      progress: IPC_CHANNELS.GITHUB_PR_REVIEW_PROGRESS,
      error: IPC_CHANNELS.GITHUB_PR_REVIEW_ERROR,
      complete: IPC_CHANNELS.GITHUB_PR_REVIEW_COMPLETE,
    },
    project.id
  );

  const config = getGitHubConfig(project);
  if (!config) {
    throw new Error("No GitHub configuration found for project");
  }

  const repo = config.repo;
  const { model, thinkingLevel } = getGitHubPRSettings();
  const reviewKey = getReviewKey(project.id, prNumber);

  safeBreadcrumb({
    category: 'pr-review',
    message: 'Starting TypeScript PR review',
    level: 'info',
    data: { model, thinkingLevel, prNumber, repo },
  });

  // Create log collector for this review
  const logCollector = new PRLogCollector(project, prNumber, repo, false, mainWindow);

  // Create AbortController for cancellation
  const abortController = new AbortController();
  runningReviews.set(reviewKey, abortController);
  debugLog("Registered review abort controller", { reviewKey });

  // zeenha fork: released in `finally`, whatever way the review ends
  let checkout: PRReviewCheckout | null = null;
  let mcp: PRReviewMcpSession | null = null;

  try {
    logCollector.processLine(`[fetching] Fetching PR #${prNumber} from GitHub...`);
    sendProgress({ phase: "fetching", prNumber, progress: 15, message: "Fetching PR data from GitHub..." });

    const context = await fetchPRContext(config, prNumber);
    logCollector.processLine(`[Context] Fetched ${context.changedFiles.length} changed files, ${context.commits.length} commits`);

    // zeenha fork: review the PR's own code, not the base branch on disk
    checkout = await preparePRReviewCheckout(project.path, prNumber);
    logCollector.processLine(
      checkout.kind === "pr-head"
        ? `[Context] Reviewing a checkout of the PR head ${checkout.sha.slice(0, 12)}`
        : `[Context] WARNING: reviewing the base branch's files, not the PR's: ${checkout.reason}`,
    );
    mcp = createPRReviewMcpSession(project.path, project.autoBuildPath || ".auto-claude", (line) =>
      logCollector.processLine(`[Context] ${line}`),
    );

    sendProgress({ phase: "analyzing", prNumber, progress: 30, message: "Starting parallel orchestrator review..." });

    const orchestratorConfig: ParallelOrchestratorConfig = {
      repo,
      projectDir: project.path,
      model: model as ModelShorthand,
      thinkingLevel: thinkingLevel as ThinkingLevel,
      reviewDir: checkout.kind === "pr-head" ? checkout.dir : undefined,
      checkoutNote: checkoutNoteFor(checkout, context.baseBranch),
      mcp,
    };

    const orchestrator = new ParallelOrchestratorReviewer(
      orchestratorConfig,
      (update) => {
        const allowedPhases = new Set(["fetching", "analyzing", "generating", "posting", "complete"]);
        const phase = (allowedPhases.has(update.phase) ? update.phase : "analyzing") as PRReviewProgress["phase"];
        sendProgress({
          phase,
          prNumber,
          progress: update.progress,
          message: update.message,
        });
        // If the message already has a bracket prefix (e.g., [Specialist:security],
        // [ParallelOrchestrator], [FindingValidator]), pass it directly so parseLogLine()
        // extracts the correct source for frontend grouping.
        // Otherwise, wrap with [phase] so bare messages aren't silently dropped.
        const logLine = update.message.startsWith('[')
          ? update.message
          : `[${update.phase}] ${update.message}`;
        logCollector.processLine(logLine);
      },
    );

    const orchestratorResult = await orchestrator.review(context, abortController.signal);

    // Map orchestrator verdict to overallStatus
    const verdictToStatus: Record<string, "approve" | "request_changes" | "comment"> = {
      ready_to_merge: "approve",
      merge_with_changes: "comment",
      needs_revision: "request_changes",
      blocked: "request_changes",
    };
    const overallStatus = verdictToStatus[orchestratorResult.verdict] ?? "comment";

    const result: PRReviewResult = {
      prNumber,
      repo,
      success: true,
      findings: orchestratorResult.findings as PRReviewFinding[],
      summary: orchestratorResult.summary,
      overallStatus,
      reviewedAt: new Date().toISOString(),
    };

    // Save to disk
    saveReviewResultToDisk(project, prNumber, result);
    debugLog("Review result saved to disk", { findingsCount: result.findings.length });

    // Emit synthesis-phase log lines before finalizing
    logCollector.processLine(`[Summary] ${orchestratorResult.findings.length} findings, verdict: ${orchestratorResult.verdict}`);
    logCollector.processLine(`[Summary] Agents: ${orchestratorResult.agentsInvoked.join(", ")}`);

    // Finalize logs
    logCollector.finalize(true);

    safeBreadcrumb({
      category: 'pr-review',
      message: 'PR review completed',
      level: 'info',
      data: { prNumber, findingsCount: result.findings.length, overallStatus },
    });

    // Save PR review insights to memory (async, non-blocking)
    savePRReviewToMemory(result, repo, false, project.id).catch((err) => {
      debugLog("Failed to save PR review to memory", { error: (err as Error).message });
    });

    return result;
  } catch (err) {
    logCollector.finalize(false);

    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Review cancelled");
    }

    safeCaptureException(
      err instanceof Error ? err : new Error(String(err)),
      { extra: { prNumber, repo } }
    );
    throw err;
  } finally {
    runningReviews.delete(reviewKey);
    debugLog("Unregistered review abort controller", { reviewKey });
    await mcp?.close().catch(() => undefined);
    if (checkout?.kind === "pr-head") await checkout.cleanup().catch(() => undefined);
  }
}
