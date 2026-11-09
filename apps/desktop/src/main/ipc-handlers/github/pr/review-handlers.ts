/**
 * PR review IPC handlers: run review, cancel review, external review notification.
 * Also registers the follow-up review handler.
 */

import { ipcMain } from "electron";
import type { BrowserWindow } from "electron";
import { IPC_CHANNELS } from "../../../../shared/constants";
import { getGitHubConfig, githubFetch } from "../utils";
import { withProjectOrNull } from "../utils/project-middleware";
import { createIPCCommunicators } from "../utils/ipc-communicator";
import type { PRReviewStateManager } from "../../../pr-review-state-manager";
import type { PRReviewResult, PRReviewProgress } from "./types";
import {
  debugLog,
  CI_WAIT_PLACEHOLDER,
  runningReviews,
  ciWaitAbortControllers,
  getReviewKey,
} from "./shared";
import { performCIWaitCheck } from "./ci-wait";
import { runPRReview } from "./review-runner";
import { registerPRFollowupHandlers } from "./followup-handlers";

/**
 * Register PR review, cancel and follow-up review handlers
 */
export function registerPRReviewHandlers(
  getMainWindow: () => BrowserWindow | null,
  stateManager: PRReviewStateManager
): void {
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
            stateManager.handleComplete(projectId, prNumber, result);
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

          stateManager.handleComplete(projectId, prNumber, result);
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

  // zeenha fork: the renderer polls for an external review's result and reports
  // it here. The preload exposed this channel with no handler, so the call
  // always rejected and the review stayed "in progress" until a restart.
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_PR_NOTIFY_EXTERNAL_REVIEW_COMPLETE,
    async (_, projectId: string, prNumber: number, result: PRReviewResult | null): Promise<void> => {
      if (typeof projectId !== "string" || !Number.isInteger(prNumber) || prNumber <= 0) return;
      stateManager.handleExternalReviewComplete(projectId, prNumber, result ?? null);
    }
  );

  registerPRFollowupHandlers(getMainWindow, stateManager);
}
