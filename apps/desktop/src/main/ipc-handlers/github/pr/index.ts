/**
 * GitHub PR Review IPC handlers (entry point)
 *
 * Handles AI-powered PR review:
 * 1. List and fetch PRs
 * 2. Run AI review with code analysis (including follow-up reviews)
 * 3. Post review comments
 * 4. Merge, polling and status updates
 */

import type { BrowserWindow } from "electron";
import { debugLog } from "./shared";
import { PRReviewStateManager } from "../../../pr-review-state-manager";
import { registerPRQueryHandlers } from "./query-handlers";
import { registerPRReviewHandlers } from "./review-handlers";
import { registerPRPostingHandlers } from "./posting-handlers";
import { registerPRMergeHandlers } from "./merge-handlers";
import { registerPRPollingHandlers } from "./polling-handlers";

export type {
  PRReviewFinding,
  PRReviewResult,
  NewCommitsCheck,
  MergeReadiness,
  PRData,
  PRListResult,
  PRReviewProgress,
} from "./types";

/**
 * Register PR-related handlers
 */
export function registerPRHandlers(getMainWindow: () => BrowserWindow | null): void {
  debugLog("Registering PR handlers");

  const stateManager = new PRReviewStateManager(getMainWindow);

  registerPRQueryHandlers(stateManager);
  registerPRReviewHandlers(getMainWindow, stateManager);
  registerPRPostingHandlers(getMainWindow);
  registerPRMergeHandlers(getMainWindow);
  registerPRPollingHandlers(getMainWindow);

  debugLog("PR handlers registered");
}
