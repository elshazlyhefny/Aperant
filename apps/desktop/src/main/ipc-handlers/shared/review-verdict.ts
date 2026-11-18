/**
 * Shared mapping from orchestrator review verdicts to an overall review status.
 */

export type ReviewOverallStatus = 'approve' | 'request_changes' | 'comment';

export const VERDICT_TO_STATUS: Record<string, ReviewOverallStatus> = {
  ready_to_merge: 'approve',
  merge_with_changes: 'comment',
  needs_revision: 'request_changes',
  blocked: 'request_changes',
};

/** Map a verdict to an overall status, falling back to 'comment' for unknown verdicts. */
export function verdictToOverallStatus(verdict: string): ReviewOverallStatus {
  return Object.hasOwn(VERDICT_TO_STATUS, verdict) ? VERDICT_TO_STATUS[verdict] : 'comment';
}
