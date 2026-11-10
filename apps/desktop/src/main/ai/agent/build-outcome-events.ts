/**
 * The task events the worker posts when a build orchestration ends, so the
 * XState task machine lands in the right state.
 *
 * zeenha fork: a build that failed before it ever entered coding (the planner
 * failed, or the plan it produced was invalid) reports PLANNING_FAILED. It
 * used to report CODING_FAILED, which the machine's `planning` state does not
 * handle, so the task stayed in planning with no worker behind it.
 */
import type { BuildOutcome } from '../orchestration/build-orchestrator';

export interface BuildOutcomeTaskEvent {
  type: string;
  extra?: Record<string, unknown>;
}

export function buildOutcomeTaskEvents(
  outcome: Pick<BuildOutcome, 'success' | 'error' | 'codingCompleted' | 'codingStarted' | 'totalIterations'>,
): BuildOutcomeTaskEvent[] {
  if (outcome.success) {
    return [{ type: 'QA_PASSED' }, { type: 'BUILD_COMPLETE' }];
  }
  if (outcome.codingCompleted) {
    // Coding succeeded but QA failed: QA-specific event, so the machine goes to
    // 'error' with reviewReason='errors' rather than a misleading CODING_FAILED.
    return [{
      type: 'QA_MAX_ITERATIONS',
      extra: { iteration: outcome.totalIterations, maxIterations: 3 },
    }];
  }
  if (!outcome.codingStarted) {
    return [{ type: 'PLANNING_FAILED', extra: { error: outcome.error, recoverable: true } }];
  }
  return [{ type: 'CODING_FAILED', extra: { error: outcome.error } }];
}

/**
 * zeenha fork: the events posted when a build or QA run stopped because the
 * token budget was reached. It replaces buildOutcomeTaskEvents, so the task
 * pauses in human_review instead of being reported as a failure.
 */
export function budgetPauseTaskEvents(budget: { used: number; limit: number }): BuildOutcomeTaskEvent[] {
  return [{ type: 'TOKEN_BUDGET_REACHED', extra: { used: budget.used, limit: budget.limit } }];
}

/** Message shown for a task paused by its token budget. */
export function budgetPauseMessage(budget: { used: number; limit: number }): string {
  return `Token budget reached: ${budget.used.toLocaleString('en-US')} of ${budget.limit.toLocaleString('en-US')} tokens used`;
}
