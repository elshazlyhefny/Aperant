/**
 * GitHub PR Review IPC handlers
 *
 * Handles AI-powered PR review:
 * 1. List and fetch PRs
 * 2. Run AI review with code analysis
 * 3. Post review comments
 * 4. Apply fixes
 */

import type { BrowserWindow } from "electron";
import { debugLog } from "./pr/shared";
import { PRReviewStateManager } from "../../pr-review-state-manager";
import { registerPRQueryHandlers } from "./pr/query-handlers";
import { registerPRPostingHandlers } from "./pr/posting-handlers";
import { registerPRReviewHandlers } from "./pr/review-handlers";
import { registerPRMergeHandlers } from "./pr/merge-handlers";
import { registerPRPollingHandlers } from "./pr/polling-handlers";

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

  registerPRReviewHandlers(getMainWindow, stateManager);
  registerPRMergeHandlers(getMainWindow);
  registerPRPollingHandlers(getMainWindow);

  debugLog("PR handlers registered");
}
