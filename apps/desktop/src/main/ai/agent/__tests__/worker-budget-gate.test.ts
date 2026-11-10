/**
 * zeenha fork: the worker's session gate. A guard already over its limit makes
 * the worker skip the model call and report a cancelled token_budget result.
 */
import { describe, expect, it } from 'vitest';

import { TokenBudgetGuard } from '../../session/token-budget';
import { TOKEN_BUDGET_ERROR_CODE } from '../../session/types';
import { budgetPauseResult, budgetGateResult } from '../budget-gate';

describe('budgetGateResult', () => {
  it('lets a session run while under the limit', () => {
    const guard = new TokenBudgetGuard({ limit: 100, readSpentTokens: () => 40 });
    expect(budgetGateResult(guard)).toBeNull();
  });

  it('returns a cancelled token_budget result once spent reaches the limit', () => {
    const guard = new TokenBudgetGuard({ limit: 100, readSpentTokens: () => 150 });
    const result = budgetGateResult(guard);
    expect(result?.outcome).toBe('cancelled');
    expect(result?.error?.code).toBe(TOKEN_BUDGET_ERROR_CODE);
    expect(result?.error?.message).toBe('Token budget reached: 150 of 100 tokens used');
  });

  it('re-reads the baseline on beginSession so a raised budget resumes', () => {
    let spent = 150;
    const guard = new TokenBudgetGuard({ limit: 100, readSpentTokens: () => spent });
    expect(budgetGateResult(guard)).not.toBeNull();
    spent = 10;
    guard.beginSession();
    expect(budgetGateResult(guard)).toBeNull();
  });

  it('never gates a guard without a limit', () => {
    const guard = new TokenBudgetGuard({ readSpentTokens: () => 1e9 });
    expect(budgetGateResult(guard)).toBeNull();
  });

  it('builds a pause result with the given counters', () => {
    const result = budgetPauseResult({ used: 5, limit: 4 }, 3, 20);
    expect(result).toMatchObject({ outcome: 'cancelled', stepsExecuted: 3, durationMs: 20 });
  });
});
