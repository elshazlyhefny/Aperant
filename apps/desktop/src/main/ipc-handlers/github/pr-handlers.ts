/**
 * GitHub PR Review IPC handlers (barrel)
 *
 * The implementation lives in ./pr/. This file is kept so that github/index.ts
 * and tests keep a stable import path.
 */

export { registerPRHandlers } from "./pr";
export type {
  PRReviewFinding,
  PRReviewResult,
  NewCommitsCheck,
  MergeReadiness,
  PRData,
  PRListResult,
  PRReviewProgress,
} from "./pr/types";
