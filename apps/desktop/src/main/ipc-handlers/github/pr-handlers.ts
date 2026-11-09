/**
 * GitHub PR Review IPC handlers
 *
 * Handles AI-powered PR review:
 * 1. List and fetch PRs
 * 2. Run AI review with code analysis
 * 3. Post review comments
 * 4. Apply fixes
 */

import { ipcMain } from "electron";
import type { BrowserWindow } from "electron";
import path from "path";
import fs from "fs";
import {
  IPC_CHANNELS,
} from "../../../shared/constants";
import { getGitHubConfig, githubFetch, } from "./utils";
import { getAugmentedEnv } from "../../env-utils";
import { withProjectOrNull } from "./utils/project-middleware";
import { landsThroughPullRequestsOnly } from "../../../shared/utils/landing-policy";
import { createIPCCommunicators } from "./utils/ipc-communicator";
import {
  ParallelFollowupReviewer,
  type FollowupReviewContext,
  type PreviousReviewResult,
} from "../../ai/runners/github/parallel-followup";
import type { ModelShorthand, ThinkingLevel } from "../../ai/config/types";
import { getPRStatusPoller } from "../../services/pr-status-poller";
import { safeBreadcrumb, } from "../../sentry";
import { PRReviewStateManager } from "../../pr-review-state-manager";
import type { PRReviewResult as PreloadPRReviewResult } from "../../../preload/api/modules/github-api";
import type {
  StartPollingRequest,
  StopPollingRequest,
  PollingMetadata,
} from "../../../shared/types/pr-status";
import type {
  PRReviewFinding,
  PRReviewResult,
  NewCommitsCheck,
  MergeReadiness,
  PRReviewProgress,
} from "./pr/types";
import {
  debugLog,
  CI_WAIT_PLACEHOLDER,
  runningReviews,
  ciWaitAbortControllers,
  getReviewKey,
  sanitizeNetworkData,
} from "./pr/shared";
import {
  PRLogCollector,
} from "./pr/review-logs";
import {
  getReviewResult,
  getGitHubPRSettings,
  saveReviewResultToDisk,
  savePRReviewToMemory,
} from "./pr/review-results";
import { performCIWaitCheck } from "./pr/ci-wait";
import { runPRReview } from "./pr/review-runner";
import { registerPRQueryHandlers } from "./pr/query-handlers";
import { registerPRPostingHandlers } from "./pr/posting-handlers";

export type {
  PRReviewFinding,
  PRReviewResult,
  NewCommitsCheck,
  MergeReadiness,
  PRData,
  PRListResult,
  PRReviewProgress,
} from "./pr/types";

/**
 * Register PR-related handlers
 */
export function registerPRHandlers(getMainWindow: () => BrowserWindow | null): void {
  debugLog("Registering PR handlers");

  const stateManager = new PRReviewStateManager(getMainWindow);

  registerPRQueryHandlers(stateManager);
  registerPRPostingHandlers(getMainWindow);

  // Run AI review
  ipcMain.on(IPC_CHANNELS.GITHUB_PR_REVIEW, async (_, projectId: string, prNumber: number) => {
    debugLog("runPRReview handler called", { projectId, prNumber });
    const mainWindow = getMainWindow();
    if (!mainWindow) {
      debugLog("No main window available");
      return;
    }

    const reviewKey = getReviewKey(projectId, prNumber);

    try {
      await withProjectOrNull(projectId, async (project) => {
        const { sendProgress, sendComplete } = createIPCCommunicators<
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

        // Check if already running — notify renderer so it can display ongoing logs
        if (runningReviews.has(reviewKey)) {
          debugLog("Review already running, notifying renderer", { reviewKey });
          sendProgress({
            phase: "analyzing",
            prNumber,
            progress: 50,
            message: "Review is already in progress. Reconnecting to ongoing review...",
          });
          return;
        }

        // Register as running BEFORE CI wait to prevent race conditions
        // Use CI_WAIT_PLACEHOLDER sentinel until real process is spawned
        runningReviews.set(reviewKey, CI_WAIT_PLACEHOLDER);
        const abortController = new AbortController();
        ciWaitAbortControllers.set(reviewKey, abortController);
        debugLog("Registered review placeholder", { reviewKey });

        // Notify XState immediately — renderer gets instant "reviewing" state
        stateManager.handleStartReview(projectId, prNumber);

        try {
          debugLog("Starting PR review", { prNumber });
          const startProgress: PRReviewProgress = {
            phase: "fetching",
            prNumber,
            progress: 5,
            message: "Assigning you to PR...",
          };
          sendProgress(startProgress);
          stateManager.handleProgress(projectId, prNumber, startProgress);

          // Auto-assign current user to PR
          const config = getGitHubConfig(project);
          if (config) {
            try {
              // Get current user
              const user = (await githubFetch(config.token, "/user")) as { login: string };
              debugLog("Auto-assigning user to PR", { prNumber, username: user.login });

              // Assign to PR
              await githubFetch(config.token, `/repos/${config.repo}/issues/${prNumber}/assignees`, {
                method: "POST",
                body: JSON.stringify({ assignees: [user.login] }),
              });
              debugLog("User assigned successfully", { prNumber, username: user.login });
            } catch (assignError) {
              // Don't fail the review if assignment fails, just log it
              debugLog("Failed to auto-assign user", {
                prNumber,
                error: assignError instanceof Error ? assignError.message : assignError,
              });
            }
          }

          // Wait for CI checks to complete before starting review
          if (config) {
            const shouldProceed = await performCIWaitCheck(
              config,
              prNumber,
              sendProgress,
              "review",
              abortController.signal
            );
            if (!shouldProceed) {
              debugLog("Review cancelled during CI wait", { reviewKey });
              return;
            }
          }

          // Clean up abort controller since CI wait is done
          ciWaitAbortControllers.delete(reviewKey);

          const fetchProgress: PRReviewProgress = {
            phase: "fetching",
            prNumber,
            progress: 10,
            message: "Fetching PR data...",
          };
          sendProgress(fetchProgress);
          stateManager.handleProgress(projectId, prNumber, fetchProgress);

          const result = await runPRReview(project, prNumber, mainWindow);

          if (result.overallStatus === "in_progress") {
            // Review is already running externally (detected by BotDetector).
            // Send the result as-is so the renderer can activate external review polling.
            debugLog("PR review already in progress externally", { prNumber });
            sendProgress({
              phase: "complete",
              prNumber,
              progress: 100,
              message: "Review already in progress",
            });
            stateManager.handleComplete(projectId, prNumber, result as unknown as PreloadPRReviewResult);
            sendComplete(result);
            return;
          }

          debugLog("PR review completed", { prNumber, findingsCount: result.findings.length });
          sendProgress({
            phase: "complete",
            prNumber,
            progress: 100,
            message: "Review complete!",
          });

          stateManager.handleComplete(projectId, prNumber, result as unknown as PreloadPRReviewResult);
          sendComplete(result);
        } finally {
          // Clean up in case we exit before runPRReview was called (e.g., cancelled during CI wait)
          // runPRReview also has its own cleanup, but delete is idempotent
          // Only delete if still placeholder (don't delete actual process entry set by runPRReview)
          const entry = runningReviews.get(reviewKey);
          if (entry === CI_WAIT_PLACEHOLDER) {
            runningReviews.delete(reviewKey);
          }
          ciWaitAbortControllers.delete(reviewKey);
        }
      });
    } catch (error) {
      debugLog("PR review failed", {
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
      const errorMessage = error instanceof Error ? error.message : "Failed to run PR review";
      stateManager.handleError(projectId, prNumber, errorMessage);
      sendError({ prNumber, error: errorMessage });
    }
  });

  // Merge PR
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_PR_MERGE,
    async (
      _,
      projectId: string,
      prNumber: number,
      mergeMethod: "merge" | "squash" | "rebase" = "squash"
    ): Promise<boolean> => {
      debugLog("mergePR handler called", { projectId, prNumber, mergeMethod });
      const mergeResult = await withProjectOrNull(projectId, async (project) => {
        try {
          const { execFileSync } = await import("child_process");
          // zeenha fork: an in-app merge would put the PR on the base branch
          // without the merge queue. Refused while PR-only landing is on.
          if (landsThroughPullRequestsOnly(project.settings)) {
            debugLog("PR merge refused: project lands through the merge queue only", { prNumber });
            return false;
          }
          debugLog("Merging PR", { prNumber, method: mergeMethod });

          // Validate prNumber to prevent command injection
          if (!Number.isInteger(prNumber) || prNumber <= 0) {
            throw new Error("Invalid PR number");
          }

          // Validate mergeMethod to prevent command injection
          const validMethods = ["merge", "squash", "rebase"];
          if (!validMethods.includes(mergeMethod)) {
            throw new Error("Invalid merge method");
          }

          // Use execFileSync with arguments array to prevent command injection
          execFileSync("gh", ["pr", "merge", String(prNumber), `--${mergeMethod}`], {
            cwd: project.path,
            env: getAugmentedEnv(),
          });
          debugLog("PR merged successfully", { prNumber });
          return true;
        } catch (error) {
          debugLog("Failed to merge PR", {
            prNumber,
            error: error instanceof Error ? error.message : error,
          });
          return false;
        }
      });
      return mergeResult ?? false;
    }
  );

  // Cancel PR review
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_PR_REVIEW_CANCEL,
    async (_, projectId: string, prNumber: number): Promise<boolean> => {
      debugLog("cancelPRReview handler called", { projectId, prNumber });
      const reviewKey = getReviewKey(projectId, prNumber);
      const entry = runningReviews.get(reviewKey);

      if (!entry) {
        debugLog("No running review found to cancel", { reviewKey });
        return false;
      }

      // Handle CI wait placeholder - review is waiting for CI checks
      if (entry === CI_WAIT_PLACEHOLDER) {
        debugLog("Review is in CI wait phase, aborting wait", { reviewKey });
        const abortController = ciWaitAbortControllers.get(reviewKey);
        if (abortController) {
          abortController.abort();
          ciWaitAbortControllers.delete(reviewKey);
        }
        runningReviews.delete(reviewKey);
        stateManager.handleCancel(projectId, prNumber);
        debugLog("CI wait cancelled", { reviewKey });
        return true;
      }

      // Handle actual AbortController - abort the running TypeScript review
      const reviewAbortController = entry;
      try {
        debugLog("Aborting review", { reviewKey });
        reviewAbortController.abort();

        // Clean up the registry
        runningReviews.delete(reviewKey);
        stateManager.handleCancel(projectId, prNumber);
        debugLog("Review aborted", { reviewKey });
        return true;
      } catch (error) {
        debugLog("Failed to cancel review", {
          reviewKey,
          error: error instanceof Error ? error.message : error,
        });
        return false;
      }
    }
  );

  // Check for new commits since last review
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_PR_CHECK_NEW_COMMITS,
    async (_, projectId: string, prNumber: number): Promise<NewCommitsCheck> => {
      debugLog("checkNewCommits handler called", { projectId, prNumber });

      const result = await withProjectOrNull(projectId, async (project) => {
        // Check if review exists and has reviewed_commit_sha
        const githubDir = path.join(project.path, ".auto-claude", "github");
        const reviewPath = path.join(githubDir, "pr", `review_${prNumber}.json`);

        let review: PRReviewResult;
        try {
          const rawData = fs.readFileSync(reviewPath, "utf-8");
          const sanitizedData = sanitizeNetworkData(rawData);
          review = JSON.parse(sanitizedData);
        } catch {
          // File doesn't exist or couldn't be read
          return { hasNewCommits: false, newCommitCount: 0 };
        }

        // Normalize snake_case to camelCase for backwards compatibility with old saved files
        const reviewedCommitSha = review.reviewedCommitSha ?? (review as any).reviewed_commit_sha;
        if (!reviewedCommitSha) {
          debugLog("No reviewedCommitSha in review", { prNumber });
          return { hasNewCommits: false, newCommitCount: 0 };
        }

        // Get current PR HEAD
        const config = getGitHubConfig(project);
        if (!config) {
          return { hasNewCommits: false, newCommitCount: 0 };
        }

        // Fetch PR data to get current HEAD (before try block so it's accessible in catch)
        let currentHeadSha: string;
        try {
          const prData = (await githubFetch(
            config.token,
            `/repos/${config.repo}/pulls/${prNumber}`
          )) as { head: { sha: string }; commits: number };
          currentHeadSha = prData.head.sha;
        } catch (error) {
          debugLog("Error fetching PR data", {
            prNumber,
            error: error instanceof Error ? error.message : error,
          });
          return { hasNewCommits: false, newCommitCount: 0 };
        }

        // Early return if SHAs match - no new commits
        if (reviewedCommitSha === currentHeadSha) {
          return {
            hasNewCommits: false,
            newCommitCount: 0,
            lastReviewedCommit: reviewedCommitSha,
            currentHeadCommit: currentHeadSha,
            hasCommitsAfterPosting: false,
          };
        }

        // Try to get detailed comparison
        try {
          // Get comparison to count new commits and see what files changed
          const comparison = (await githubFetch(
            config.token,
            `/repos/${config.repo}/compare/${reviewedCommitSha}...${currentHeadSha}`
          )) as {
            ahead_by?: number;
            total_commits?: number;
            commits?: Array<{
              commit: { committer: { date: string }; message: string };
              parents?: Array<{ sha: string }>;
            }>;
            files?: Array<{ filename: string }>;
          };

          // Check if findings have been posted and if new commits are after the posting date
          const postedAt = review.postedAt || (review as any).posted_at;
          let hasCommitsAfterPosting = true; // Default to true if we can't determine

          if (postedAt && comparison.commits && comparison.commits.length > 0) {
            const postedAtDate = new Date(postedAt);
            // Check if any commit is newer than when findings were posted
            hasCommitsAfterPosting = comparison.commits.some((c) => {
              const commitDate = new Date(c.commit.committer.date);
              return commitDate > postedAtDate;
            });
            debugLog("Comparing commit dates with posted_at", {
              prNumber,
              postedAt,
              latestCommitDate:
                comparison.commits[comparison.commits.length - 1]?.commit.committer.date,
              hasCommitsAfterPosting,
            });
          } else if (!postedAt) {
            // If findings haven't been posted yet, we can't determine "after posting"
            // Follow-up should only be available after initial review is posted to GitHub
            hasCommitsAfterPosting = false;
          }

          // Check if this looks like a merge from base branch (develop/main)
          // Merge commits always have 2+ parents, so we check for that AND a merge-like message
          // Pattern matches: "Merge branch", "Merge pull request", "Merge remote-tracking",
          // "Merge 'develop' into", "Merge develop into", GitHub's "Update branch" button, etc.
          const isMergeFromBase = comparison.commits?.some((c) => {
            const hasTwoParents = (c.parents?.length ?? 0) >= 2;
            const isMergeMessage = /^merge\s+/i.test(c.commit.message);
            return hasTwoParents && isMergeMessage;
          }) ?? false;

          // Get files that had findings from the review
          const findingFiles = new Set<string>(
            (review.findings || []).map((f) => f.file).filter(Boolean)
          );

          // Get files changed in the new commits
          const newCommitFiles = (comparison.files || []).map((f) => f.filename);

          // Check for overlap between new commit files and finding files
          const overlappingFiles = newCommitFiles.filter((f) => findingFiles.has(f));
          const hasOverlapWithFindings = overlappingFiles.length > 0;

          debugLog("File overlap check", {
            prNumber,
            findingFilesCount: findingFiles.size,
            newCommitFilesCount: newCommitFiles.length,
            overlappingFiles,
            hasOverlapWithFindings,
            isMergeFromBase,
          });

          return {
            hasNewCommits: true,
            newCommitCount: comparison.ahead_by || comparison.total_commits || 1,
            lastReviewedCommit: reviewedCommitSha,
            currentHeadCommit: currentHeadSha,
            hasCommitsAfterPosting,
            hasOverlapWithFindings,
            overlappingFiles: overlappingFiles.length > 0 ? overlappingFiles : undefined,
            isMergeFromBase,
          };
        } catch (error) {
          // Comparison failed (e.g., force push made old commit unreachable)
          // Since we already verified SHAs differ, treat as having new commits
          debugLog(
            "Comparison failed but SHAs differ - likely force push, treating as new commits",
            {
              prNumber,
              reviewedCommitSha,
              currentHeadSha,
              error: error instanceof Error ? error.message : error,
            }
          );
          // Note: hasOverlapWithFindings, overlappingFiles, isMergeFromBase intentionally omitted
          // since we can't determine them without the comparison API. UI defaults to safe behavior
          // (hasOverlapWithFindings ?? true) which prompts user to verify.
          return {
            hasNewCommits: true,
            newCommitCount: 1, // Unknown count due to force push
            lastReviewedCommit: reviewedCommitSha,
            currentHeadCommit: currentHeadSha,
            hasCommitsAfterPosting: true, // Assume yes for force push scenarios
          };
        }
      });

      return result ?? { hasNewCommits: false, newCommitCount: 0 };
    }
  );

  // Check merge readiness (lightweight freshness check for verdict validation)
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_PR_CHECK_MERGE_READINESS,
    async (_, projectId: string, prNumber: number): Promise<MergeReadiness> => {
      debugLog("checkMergeReadiness handler called", { projectId, prNumber });

      const defaultResult: MergeReadiness = {
        isDraft: false,
        mergeable: "UNKNOWN",
        isBehind: false,
        ciStatus: "none",
        blockers: [],
      };

      const result = await withProjectOrNull(projectId, async (project) => {
        const config = getGitHubConfig(project);
        if (!config) {
          debugLog("No GitHub config found for checkMergeReadiness");
          return defaultResult;
        }

        try {
          // Fetch PR data including mergeable status
          const pr = (await githubFetch(
            config.token,
            `/repos/${config.repo}/pulls/${prNumber}`
          )) as {
            draft: boolean;
            mergeable: boolean | null;
            mergeable_state: string;
            head: { sha: string };
          };

          // Determine mergeable status
          let mergeable: MergeReadiness["mergeable"] = "UNKNOWN";
          if (pr.mergeable === true) {
            mergeable = "MERGEABLE";
          } else if (pr.mergeable === false || pr.mergeable_state === "dirty") {
            mergeable = "CONFLICTING";
          }

          // Check if branch is behind base (out of date)
          // GitHub's mergeable_state can be: 'behind', 'blocked', 'clean', 'dirty', 'has_hooks', 'unknown', 'unstable'
          const isBehind = pr.mergeable_state === "behind";

          // Fetch combined commit status for CI
          let ciStatus: MergeReadiness["ciStatus"] = "none";
          try {
            const status = (await githubFetch(
              config.token,
              `/repos/${config.repo}/commits/${pr.head.sha}/status`
            )) as {
              state: "success" | "pending" | "failure" | "error";
              total_count: number;
            };

            if (status.total_count === 0) {
              // No status checks, check for check runs (GitHub Actions)
              const checkRuns = (await githubFetch(
                config.token,
                `/repos/${config.repo}/commits/${pr.head.sha}/check-runs`
              )) as {
                total_count: number;
                check_runs: Array<{ conclusion: string | null; status: string }>;
              };

              if (checkRuns.total_count > 0) {
                const hasFailing = checkRuns.check_runs.some(
                  (cr) => cr.conclusion === "failure" || cr.conclusion === "cancelled"
                );
                const hasPending = checkRuns.check_runs.some((cr) => cr.status !== "completed");

                if (hasFailing) {
                  ciStatus = "failing";
                } else if (hasPending) {
                  ciStatus = "pending";
                } else {
                  ciStatus = "passing";
                }
              }
            } else {
              // Use combined status
              if (status.state === "success") {
                ciStatus = "passing";
              } else if (status.state === "pending") {
                ciStatus = "pending";
              } else {
                ciStatus = "failing";
              }
            }
          } catch (err) {
            debugLog("Failed to fetch CI status", {
              prNumber,
              error: err instanceof Error ? err.message : err,
            });
            // Continue without CI status
          }

          // Build blockers list
          const blockers: string[] = [];
          if (pr.draft) {
            blockers.push("PR is in draft mode");
          }
          if (mergeable === "CONFLICTING") {
            blockers.push("Merge conflicts detected");
          }
          if (isBehind) {
            blockers.push("Branch is out of date with base branch. Update to check for conflicts.");
          }
          if (ciStatus === "failing") {
            blockers.push("CI checks are failing");
          }

          debugLog("checkMergeReadiness result", {
            prNumber,
            isDraft: pr.draft,
            mergeable,
            isBehind,
            ciStatus,
            blockers,
          });

          return {
            isDraft: pr.draft,
            mergeable,
            isBehind,
            ciStatus,
            blockers,
          };
        } catch (error) {
          debugLog("Failed to check merge readiness", {
            prNumber,
            error: error instanceof Error ? error.message : error,
          });
          return defaultResult;
        }
      });

      return result ?? defaultResult;
    }
  );

  // Update PR branch (sync with base branch)
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_PR_UPDATE_BRANCH,
    async (_, projectId: string, prNumber: number): Promise<{ success: boolean; error?: string }> => {
      debugLog("updateBranch handler called", { projectId, prNumber });

      const updateResult = await withProjectOrNull(projectId, async (project) => {
        try {
          const { execFile } = await import("child_process");
          const { promisify } = await import("util");
          const execFileAsync = promisify(execFile);
          debugLog("Updating PR branch", { prNumber });

          // Validate prNumber to prevent command injection
          if (!Number.isInteger(prNumber) || prNumber <= 0) {
            throw new Error("Invalid PR number");
          }

          // Use gh pr update-branch to sync with base branch (async to avoid blocking main process)
          // --rebase is not used to avoid force-push requirements
          await execFileAsync("gh", ["pr", "update-branch", String(prNumber)], {
            cwd: project.path,
            env: getAugmentedEnv(),
          });

          debugLog("PR branch updated successfully", { prNumber });
          return { success: true };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          debugLog("Failed to update PR branch", { prNumber, error: errorMessage });

          // Map common error patterns to user-friendly messages
          let friendlyError = errorMessage;
          if (errorMessage.includes("permission") || errorMessage.includes("403")) {
            friendlyError = "You don't have permission to update this branch.";
          } else if (errorMessage.includes("401") || errorMessage.toLowerCase().includes("auth") || errorMessage.toLowerCase().includes("token")) {
            friendlyError = "Authentication failed. Try running 'gh auth login' to re-authenticate.";
          } else if (errorMessage.includes("404") || errorMessage.includes("not found")) {
            friendlyError = "Pull request not found. It may have been closed or deleted.";
          } else if (errorMessage.includes("429") || errorMessage.toLowerCase().includes("rate limit")) {
            friendlyError = "GitHub API rate limit exceeded. Please wait and try again.";
          } else if (errorMessage.includes("conflict")) {
            friendlyError = "Cannot update branch due to merge conflicts. Resolve conflicts manually.";
          } else if (errorMessage.toLowerCase().includes("protected") || errorMessage.toLowerCase().includes("branch protection")) {
            friendlyError = "Branch protection rules prevent this update.";
          } else if (errorMessage.includes("ENOTFOUND") || errorMessage.includes("ECONNREFUSED") || errorMessage.includes("ETIMEDOUT")) {
            friendlyError = "Network error. Check your internet connection and try again.";
          } else if (errorMessage.toLowerCase().includes("already up to date")) {
            return { success: true }; // Not an error
          }

          return { success: false, error: friendlyError };
        }
      });

      return updateResult ?? { success: false, error: "Project not found" };
    }
  );

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
          stateManager.handleStartFollowupReview(projectId, prNumber, previousResultForState as PreloadPRReviewResult | undefined);

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

            stateManager.handleComplete(projectId, prNumber, result as unknown as PreloadPRReviewResult);
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

  // Get workflows awaiting approval for a PR (fork PRs)
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_WORKFLOWS_AWAITING_APPROVAL,
    async (
      _,
      projectId: string,
      prNumber: number
    ): Promise<{
      awaiting_approval: number;
      workflow_runs: Array<{ id: number; name: string; html_url: string; workflow_name: string }>;
      can_approve: boolean;
      error?: string;
    }> => {
      debugLog("getWorkflowsAwaitingApproval handler called", { projectId, prNumber });
      const result = await withProjectOrNull(projectId, async (project) => {
        const config = getGitHubConfig(project);
        if (!config) {
          return {
            awaiting_approval: 0,
            workflow_runs: [],
            can_approve: false,
            error: "No GitHub config",
          };
        }

        try {
          // First get the PR's head SHA
          const prData = (await githubFetch(
            config.token,
            `/repos/${config.repo}/pulls/${prNumber}`
          )) as { head?: { sha?: string } };

          const headSha = prData?.head?.sha;
          if (!headSha) {
            return { awaiting_approval: 0, workflow_runs: [], can_approve: false };
          }

          // Query workflow runs with action_required status
          const runsData = (await githubFetch(
            config.token,
            `/repos/${config.repo}/actions/runs?status=action_required&per_page=100`
          )) as {
            workflow_runs?: Array<{
              id: number;
              name: string;
              html_url: string;
              head_sha: string;
              workflow?: { name?: string };
            }>;
          };

          const allRuns = runsData?.workflow_runs || [];

          // Filter to only runs for this PR's head SHA
          const prRuns = allRuns
            .filter((run) => run.head_sha === headSha)
            .map((run) => ({
              id: run.id,
              name: run.name,
              html_url: run.html_url,
              workflow_name: run.workflow?.name || "Unknown",
            }));

          debugLog("Found workflows awaiting approval", { prNumber, count: prRuns.length });

          return {
            awaiting_approval: prRuns.length,
            workflow_runs: prRuns,
            can_approve: true, // Assume token has permission; will fail if not
          };
        } catch (error) {
          debugLog("Failed to get workflows awaiting approval", {
            prNumber,
            error: error instanceof Error ? error.message : error,
          });
          return {
            awaiting_approval: 0,
            workflow_runs: [],
            can_approve: false,
            error: error instanceof Error ? error.message : "Unknown error",
          };
        }
      });

      return result ?? { awaiting_approval: 0, workflow_runs: [], can_approve: false };
    }
  );

  // zeenha fork: the renderer polls for an external review's result and reports
  // it here. The preload exposed this channel with no handler, so the call
  // always rejected and the review stayed "in progress" until a restart.
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_PR_NOTIFY_EXTERNAL_REVIEW_COMPLETE,
    async (_, projectId: string, prNumber: number, result: PreloadPRReviewResult | null): Promise<void> => {
      if (typeof projectId !== "string" || !Number.isInteger(prNumber) || prNumber <= 0) return;
      stateManager.handleExternalReviewComplete(projectId, prNumber, result ?? null);
    }
  );

  // Approve a workflow run
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_WORKFLOW_APPROVE,
    async (_, projectId: string, runId: number): Promise<boolean> => {
      debugLog("approveWorkflow handler called", { projectId, runId });
      const result = await withProjectOrNull(projectId, async (project) => {
        const config = getGitHubConfig(project);
        if (!config) {
          debugLog("No GitHub config found");
          return false;
        }

        try {
          // Approve the workflow run
          await githubFetch(config.token, `/repos/${config.repo}/actions/runs/${runId}/approve`, {
            method: "POST",
          });

          debugLog("Workflow approved successfully", { runId });
          return true;
        } catch (error) {
          debugLog("Failed to approve workflow", {
            runId,
            error: error instanceof Error ? error.message : error,
          });
          return false;
        }
      });

      return result ?? false;
    }
  );

  // ============================================================================
  // PR Status Polling Handlers
  // ============================================================================

  // Initialize PRStatusPoller with main window getter for IPC updates
  const prStatusPoller = getPRStatusPoller();
  prStatusPoller.setMainWindowGetter(getMainWindow);

  // Start polling PR status for a project
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_PR_STATUS_POLL_START,
    async (
      _,
      request: StartPollingRequest
    ): Promise<{ success: boolean; error?: string }> => {
      debugLog("startStatusPolling handler called", {
        projectId: request.projectId,
        prCount: request.prNumbers.length,
      });

      const result = await withProjectOrNull(request.projectId, async (project) => {
        const config = getGitHubConfig(project);
        if (!config) {
          debugLog("No GitHub config found for project, cannot start polling");
          return { success: false, error: "No GitHub configuration found" };
        }

        try {
          await prStatusPoller.startPolling(
            request.projectId,
            request.prNumbers,
            config.token
          );
          debugLog("Status polling started successfully", {
            projectId: request.projectId,
          });
          return { success: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          debugLog("Failed to start status polling", {
            projectId: request.projectId,
            error: message,
          });
          return { success: false, error: message };
        }
      });
      return result ?? { success: false, error: "Project not found" };
    }
  );

  // Stop polling PR status for a project
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_PR_STATUS_POLL_STOP,
    async (
      _,
      request: StopPollingRequest
    ): Promise<{ success: boolean }> => {
      debugLog("stopStatusPolling handler called", {
        projectId: request.projectId,
      });

      try {
        prStatusPoller.stopPolling(request.projectId);
        debugLog("Status polling stopped successfully", {
          projectId: request.projectId,
        });
        return { success: true };
      } catch (error) {
        debugLog("Failed to stop status polling", {
          projectId: request.projectId,
          error: error instanceof Error ? error.message : error,
        });
        return { success: false };
      }
    }
  );

  // Get current polling metadata for a project
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_PR_STATUS_UPDATE,
    async (_, projectId: string): Promise<PollingMetadata> => {
      debugLog("getPollingMetadata handler called", { projectId });
      return prStatusPoller.getPollingMetadata(projectId);
    }
  );

  debugLog("PR handlers registered");
}
