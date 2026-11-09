/**
 * Shared PR types for the GitHub PR IPC handlers.
 */

/**
 * PR review finding from AI analysis
 */
export interface PRReviewFinding {
  id: string;
  severity: "critical" | "high" | "medium" | "low";
  category: "security" | "quality" | "style" | "test" | "docs" | "pattern" | "performance" | "verification_failed";
  title: string;
  description: string;
  file: string;
  line: number;
  endLine?: number;
  suggestedFix?: string;
  fixable: boolean;
  validationStatus?: "confirmed_valid" | "dismissed_false_positive" | "needs_human_review" | null;
  validationExplanation?: string;
  sourceAgents?: string[];
  crossValidated?: boolean;
}

/**
 * Complete PR review result
 */
export interface PRReviewResult {
  prNumber: number;
  repo: string;
  success: boolean;
  findings: PRReviewFinding[];
  summary: string;
  overallStatus: "approve" | "request_changes" | "comment" | "in_progress";
  reviewId?: number;
  reviewedAt: string;
  error?: string;
  // Follow-up review fields
  reviewedCommitSha?: string;
  reviewedFileBlobs?: Record<string, string>; // filename → blob SHA for rebase-resistant follow-ups
  isFollowupReview?: boolean;
  previousReviewId?: number;
  resolvedFindings?: string[];
  unresolvedFindings?: string[];
  newFindingsSinceLastReview?: string[];
  // Track if findings have been posted to GitHub (enables follow-up review)
  hasPostedFindings?: boolean;
  postedFindingIds?: string[];
  postedAt?: string;
  // In-progress review tracking
  inProgressSince?: string;
}

/**
 * Result of checking for new commits since last review
 */
export interface NewCommitsCheck {
  hasNewCommits: boolean;
  newCommitCount: number;
  lastReviewedCommit?: string;
  currentHeadCommit?: string;
  /** Whether new commits happened AFTER findings were posted (for "Ready for Follow-up" status) */
  hasCommitsAfterPosting?: boolean;
  /** Whether new commits touch files that had findings (requires verification) */
  hasOverlapWithFindings?: boolean;
  /** Files from new commits that overlap with finding files */
  overlappingFiles?: string[];
  /** Whether this appears to be a merge from base branch (develop/main) */
  isMergeFromBase?: boolean;
}

/**
 * Lightweight merge readiness check result
 * Used for real-time validation of AI verdict freshness
 */
export interface MergeReadiness {
  /** PR is in draft mode */
  isDraft: boolean;
  /** GitHub's mergeable status */
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  /** Branch is behind base branch (out of date) */
  isBehind: boolean;
  /** Simplified CI status */
  ciStatus: "passing" | "failing" | "pending" | "none";
  /** List of blockers that contradict a "ready to merge" verdict */
  blockers: string[];
}

/**
 * PR data from GitHub API
 */
export interface PRData {
  number: number;
  title: string;
  body: string;
  state: string;
  author: { login: string };
  headRefName: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  assignees: Array<{ login: string }>;
  files: Array<{
    path: string;
    additions: number;
    deletions: number;
    status: string;
  }>;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
}

/**
 * PR list result with pagination info
 */
export interface PRListResult {
  prs: PRData[];
  hasNextPage: boolean; // True if more PRs exist beyond the 100 limit
  endCursor?: string | null; // Cursor for fetching next page (null if no more pages)
}

/**
 * PR review progress status
 */
export interface PRReviewProgress {
  phase: "fetching" | "analyzing" | "generating" | "posting" | "complete";
  prNumber: number;
  progress: number;
  message: string;
}
