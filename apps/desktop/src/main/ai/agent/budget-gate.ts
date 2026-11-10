/**
 * zeenha fork: pure helpers for the worker's token budget gate, kept out of
 * worker.ts (which runs on import) so they can be unit tested.
 */
import type { TokenBudgetGuard } from '../session/token-budget';
import { TOKEN_BUDGET_ERROR_CODE, type SessionResult } from '../session/types';
import { budgetPauseMessage } from './build-outcome-events';

/** The cancelled result for a session that must not start because the budget is spent; null when it may run. */
export function budgetGateResult(guard: TokenBudgetGuard): SessionResult | null {
  if (!guard.isExceeded(0)) return null;
  return budgetPauseResult(guard.snapshot(), 0, 0);
}

/** The cancelled SessionResult that reports a budget pause; the bridge treats it as a clean stop. */
export function budgetPauseResult(
  budget: { used: number; limit: number },
  stepsExecuted: number,
  durationMs: number,
): SessionResult {
  return {
    outcome: 'cancelled',
    stepsExecuted,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    messages: [],
    toolCallCount: 0,
    durationMs,
    error: { code: TOKEN_BUDGET_ERROR_CODE, message: budgetPauseMessage(budget), retryable: false },
  };
}
