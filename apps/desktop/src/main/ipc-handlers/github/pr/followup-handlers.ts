/**
 * PR follow-up review IPC handler.
 */

import { ipcMain } from "electron";
import type { BrowserWindow } from "electron";
import { IPC_CHANNELS } from "../../../../shared/constants";
import { getGitHubConfig, githubFetch } from "../utils";
import { withProjectOrNull } from "../utils/project-middleware";
import { createIPCCommunicators } from "../utils/ipc-communicator";
import {
  ParallelFollowupReviewer,
  type FollowupReviewContext,
  type PreviousReviewResult,
} from "../../../ai/runners/github/parallel-followup";
import type { ModelShorthand, ThinkingLevel } from "../../../ai/config/types";
import { safeBreadcrumb } from "../../../sentry";
import type { PRReviewStateManager } from "../../../pr-review-state-manager";
import type { PRReviewFinding, PRReviewResult, PRReviewProgress } from "./types";
import {
  debugLog,
  CI_WAIT_PLACEHOLDER,
  runningReviews,
  ciWaitAbortControllers,
  getReviewKey,
} from "./shared";
import { PRLogCollector } from "./review-logs";
import {
  getReviewResult,
  getGitHubPRSettings,
  saveReviewResultToDisk,
  savePRReviewToMemory,
} from "./review-results";
import { performCIWaitCheck } from "./ci-wait";

/**
 * Register PR follow-up review handler
 */
export function registerPRFollowupHandlers(
  getMainWindow: () => BrowserWindow | null,
  stateManager: PRReviewStateManager
): void {
  // Run follow-up review
  ipcMain.on(
    IPC_CHANNELS.GITHUB_PR_FOLLOWUP_REVIEW,
    async (_, projectId: string, prNumber: number) => {
      debugLog("followupReview handler called", { projectId, prNumber });
      const mainWindow = getMainWindow();
      if (!mainWindow) {
        debugLog("No main window available");
        return;
      }

      try {
        await withProjectOrNull(projectId, async (project) => {
          const { sendProgress, sendError, sendComplete } = createIPCCommunicators<
            PRReviewProgress,
            PRReviewResult
          >(
            mainWindow,
            {
              progress: IPC_CHANNELS.GITHUB_PR_REVIEW_PROGRESS,
              error: IPC_CHANNELS.GITHUB_PR_REVIEW_ERROR,
              complete: IPC_CHANNELS.GITHUB_PR_REVIEW_COMPLETE,
            },
            projectId
          );

          const config = getGitHubConfig(project);
          if (!config) {
            sendError({ prNumber, error: "No GitHub configuration found for project" });
            return;
          }

          const reviewKey = getReviewKey(projectId, prNumber);

          // Check if already running
          if (runningReviews.has(reviewKey)) {
            debugLog("Follow-up review already running", { reviewKey });
            return;
          }

          // Register as running BEFORE CI wait to prevent race conditions
          // Use CI_WAIT_PLACEHOLDER sentinel until real process is spawned
          runningReviews.set(reviewKey, CI_WAIT_PLACEHOLDER);
          const abortController = new AbortController();
          ciWaitAbortControllers.set(reviewKey, abortController);
          debugLog("Registered follow-up review placeholder", { reviewKey });

          // Get previous result for XState followup context
          const previousResultForState = getReviewResult(project, prNumber) ?? undefined;
          stateManager.handleStartFollowupReview(projectId, prNumber, previousResultForState as PRReviewResult | undefined);

          try {
            debugLog("Starting follow-up review", { prNumber });
            const followupStartProgress: PRReviewProgress = {
              phase: "fetching",
              prNumber,
              progress: 5,
              message: "Starting follow-up review...",
            };
            sendProgress(followupStartProgress);
            stateManager.handleProgress(projectId, prNumber, followupStartProgress);

            // Wait for CI checks to complete before starting follow-up review
            const shouldProceed = await performCIWaitCheck(
              config,
              prNumber,
              sendProgress,
              "follow-up review",
              abortController.signal
            );
            if (!shouldProceed) {
              debugLog("Follow-up review cancelled during CI wait", { reviewKey });
              return;
            }

            // Clean up abort controller since CI wait is done
            ciWaitAbortControllers.delete(reviewKey);

            const repo = config.repo;
            const { model, thinkingLevel } = getGitHubPRSettings();

            safeBreadcrumb({
              category: 'pr-review',
              message: 'Starting TypeScript follow-up PR review',
              level: 'info',
              data: { model, thinkingLevel, prNumber, repo },
            });

            // Create log collector for this follow-up review
            const logCollector = new PRLogCollector(project, prNumber, repo, true, mainWindow);

            // Upgrade to real AbortController now that CI wait is done
            const reviewAbortController = new AbortController();
            runningReviews.set(reviewKey, reviewAbortController);
            debugLog("Registered follow-up review abort controller", { reviewKey });

            // Fetch incremental PR data for follow-up
            const fetchChangesProgress: PRReviewProgress = { phase: "fetching", prNumber, progress: 20, message: "Fetching PR changes since last review..." };
            sendProgress(fetchChangesProgress);
            stateManager.handleProgress(projectId, prNumber, fetchChangesProgress);

            // Get the previous review result for context
            const previousReviewResult = getReviewResult(project, prNumber);
            const previousReview: PreviousReviewResult = {
              reviewId: previousReviewResult?.reviewId,
              prNumber,
              findings: previousReviewResult?.findings ?? [],
              summary: previousReviewResult?.summary,
            };

            // Fetch current PR commits
            const currentCommits = (await githubFetch(
              config.token,
              `/repos/${config.repo}/pulls/${prNumber}/commits?per_page=100`
            )) as Array<{ sha: string; commit: { message: string; committer?: { date?: string } } }>;

            const currentSha = currentCommits[currentCommits.length - 1]?.sha ?? "";
            const previousSha = previousReviewResult?.reviewedCommitSha ?? "";

            // Get diff since last review
            let diffSinceReview = "";
            try {
              const filesChanged = (await githubFetch(
                config.token,
                `/repos/${config.repo}/pulls/${prNumber}/files?per_page=100`
              )) as Array<{ filename: string; patch?: string; status: string }>;
              diffSinceReview = filesChanged
                .filter((f) => f.patch)
                .map((f) => `diff --git a/${f.filename} b/${f.filename}\n${f.patch}`)
                .join("\n");
            } catch {
              // Non-critical
            }

            // Fetch comments since last review
            const contributorComments: Array<Record<string, unknown>> = [];
            const aiBotComments: Array<Record<string, unknown>> = [];
            try {
              const allComments = (await githubFetch(
                config.token,
                `/repos/${config.repo}/issues/${prNumber}/comments?per_page=100`
              )) as Array<{ id: number; user: { login: string }; body: string; created_at: string }>;
              const AI_BOTS = ["coderabbitai", "cursor-ai", "greptile", "sourcery-ai", "codeflash-ai"];
              for (const c of allComments) {
                const isBot = AI_BOTS.some((bot) => c.user.login.toLowerCase().includes(bot));
                if (isBot) {
                  aiBotComments.push({ id: c.id, author: c.user.login, body: c.body, created_at: c.created_at });
                } else {
                  contributorComments.push({ id: c.id, author: c.user.login, body: c.body, created_at: c.created_at });
                }
              }
            } catch {
              // Non-critical
            }

            const followupContext: FollowupReviewContext = {
              prNumber,
              previousReview,
              previousCommitSha: previousSha,
              currentCommitSha: currentSha,
              commitsSinceReview: currentCommits.map((c) => ({
                sha: c.sha,
                message: c.commit.message,
                committedAt: c.commit.committer?.date ?? "",
              })),
              filesChangedSinceReview: [],
              diffSinceReview,
              contributorCommentsSinceReview: contributorComments,
              aiBotCommentsSinceReview: aiBotComments,
              prReviewsSinceReview: [],
            };

            const analyzeProgress: PRReviewProgress = { phase: "analyzing", prNumber, progress: 35, message: "Running follow-up analysis..." };
            sendProgress(analyzeProgress);
            stateManager.handleProgress(projectId, prNumber, analyzeProgress);

            const followupReviewer = new ParallelFollowupReviewer(
              {
                repo,
                model: model as ModelShorthand,
                thinkingLevel: thinkingLevel as ThinkingLevel,
              },
              (update) => {
                const allowedPhases = new Set(["fetching", "analyzing", "generating", "posting", "complete"]);
                const phase = (allowedPhases.has(update.phase) ? update.phase : "analyzing") as PRReviewProgress["phase"];
                const progressUpdate: PRReviewProgress = {
                  phase,
                  prNumber,
                  progress: update.progress,
                  message: update.message,
                };
                sendProgress(progressUpdate);
                stateManager.handleProgress(projectId, prNumber, progressUpdate);
                // If the message already has a bracket prefix, pass it directly so
                // parseLogLine() extracts the correct source for frontend grouping.
                // Otherwise, wrap with [phase] so bare messages aren't silently dropped.
                const logLine = update.message.startsWith('[')
                  ? update.message
                  : `[${update.phase}] ${update.message}`;
                logCollector.processLine(logLine);
              }
            );

            const followupResult = await followupReviewer.review(followupContext, reviewAbortController.signal);

            // zeenha fork: review() folds an internal failure into
            // success:false; it used to be saved and shown as a completed
            // review (with whatever status it carried). Report it as an error.
            if (!followupResult.success) {
              logCollector.finalize(false);
              throw new Error(followupResult.summary || 'Follow-up review failed before it could check the PR');
            }

            // Build PRReviewResult from FollowupReviewResult
            const result: PRReviewResult = {
              prNumber,
              repo,
              success: true,
              findings: followupResult.findings as PRReviewFinding[],
              summary: followupResult.summary,
              overallStatus: followupResult.overallStatus as PRReviewResult["overallStatus"],
              reviewedAt: new Date().toISOString(),
              reviewedCommitSha: followupResult.reviewedCommitSha,
              isFollowupReview: true,
              previousReviewId: typeof followupResult.previousReviewId === "number" ? followupResult.previousReviewId : undefined,
              resolvedFindings: followupResult.resolvedFindings,
              unresolvedFindings: followupResult.unresolvedFindings,
              newFindingsSinceLastReview: followupResult.newFindingsSinceLastReview,
            };

            // Save to disk
            saveReviewResultToDisk(project, prNumber, result);
            debugLog("Follow-up review result saved to disk", { findingsCount: result.findings.length });

            // Finalize logs
            logCollector.finalize(true);

            safeBreadcrumb({
              category: 'pr-review',
              message: 'Follow-up PR review completed',
              level: 'info',
              data: { prNumber, findingsCount: result.findings.length },
            });

            // Save follow-up PR review insights to memory (async, non-blocking)
            savePRReviewToMemory(result, repo, true, project.id).catch((err) => {
              debugLog("Failed to save follow-up PR review to memory", { error: (err as Error).message });
            });

            debugLog("Follow-up review completed", {
              prNumber,
              findingsCount: result.findings.length,
            });
            sendProgress({
              phase: "complete",
              prNumber,
              progress: 100,
              message: "Follow-up review complete!",
            });

            stateManager.handleComplete(projectId, prNumber, result);
            sendComplete(result);
          } finally {
            // Always clean up registry, whether we exit normally or via error
            runningReviews.delete(reviewKey);
            ciWaitAbortControllers.delete(reviewKey);
            debugLog("Unregistered follow-up review", { reviewKey });
          }
        });
      } catch (error) {
        debugLog("Follow-up review failed", {
          prNumber,
          error: error instanceof Error ? error.message : error,
        });
        const { sendError } = createIPCCommunicators<PRReviewProgress, PRReviewResult>(
          mainWindow,
          {
            progress: IPC_CHANNELS.GITHUB_PR_REVIEW_PROGRESS,
            error: IPC_CHANNELS.GITHUB_PR_REVIEW_ERROR,
            complete: IPC_CHANNELS.GITHUB_PR_REVIEW_COMPLETE,
          },
          projectId
        );
        const followupErrorMessage = error instanceof Error ? error.message : "Failed to run follow-up review";
        stateManager.handleError(projectId, prNumber, followupErrorMessage);
        sendError({ prNumber, error: followupErrorMessage });
      }
    }
  );
}
