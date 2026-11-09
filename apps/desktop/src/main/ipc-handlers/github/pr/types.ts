/**
 * Shared PR types for the GitHub PR IPC handlers.
 *
 * The definitions live in shared/types/pr-review.ts, the single source of truth
 * across the IPC boundary.
 */

export type {
  PRReviewFinding,
  PRReviewResult,
  NewCommitsCheck,
  MergeReadiness,
  PRData,
  PRListResult,
  PRReviewProgress,
} from "../../../../shared/types/pr-review";
