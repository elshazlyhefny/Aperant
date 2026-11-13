/**
 * zeenha fork: types for sending a task's failing CI and PR review feedback
 * back to the task's agent.
 */

export type PRFeedbackKind = 'check' | 'review_thread' | 'review';

export interface PRFeedbackItem {
  id: string;
  kind: PRFeedbackKind;
  title: string;
  summary: string;
  url?: string;
  path?: string;
  line?: number;
  author?: string;
  /** True when summary was cut to fit the size limit. */
  truncated: boolean;
}

export type PRFeedbackWorktreeReason = 'missing' | 'not_a_worktree' | 'branch_mismatch';

export type PRFeedbackBlockedReason =
  | 'worktree_missing'
  | 'pr_not_open'
  | 'agent_running'
  | 'auth_required'
  | 'no_github_config'
  | 'no_gitlab_config'
  | 'branch_mismatch';

export interface PRFeedbackResult {
  prNumber: number;
  prUrl: string;
  prState: 'open' | 'closed' | 'merged';
  headRef: string;
  headSha: string;
  worktree: {
    available: boolean;
    reason?: PRFeedbackWorktreeReason;
  };
  canStartFollowUp: boolean;
  blockedReason?: PRFeedbackBlockedReason;
  checks: PRFeedbackItem[];
  threads: PRFeedbackItem[];
  reviews: PRFeedbackItem[];
  fetchedAt: string;
}

export interface StartPRFollowUpResult {
  started: boolean;
  /** Number of selected items included in the follow-up. */
  itemCount: number;
}
