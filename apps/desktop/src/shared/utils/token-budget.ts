/**
 * zeenha fork: token budget helpers shared by the main process and renderer.
 */

/**
 * zeenha fork: weight of a cache-read token against the budget. Providers bill
 * cache reads at roughly a tenth of fresh input, and one long task measured
 * ~95% of its "tokens" as cache reads, so counting them at full weight paused
 * tasks far earlier than their real cost justified.
 */
export const CACHE_READ_BUDGET_WEIGHT = 0.1;

/**
 * Tokens that count against a budget:
 * (input - cacheRead) + output + cacheRead * CACHE_READ_BUDGET_WEIGHT.
 *
 * As documented in cli-events.ts, `input` already includes cached input, so
 * cacheRead is taken out of it and added back at its reduced weight.
 * cacheCreation stays inside `input` at full weight. The result is rounded
 * and never negative.
 */
export function budgetTokens(tokens: {
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
}): number {
  // Missing or corrupt fields (e.g. from a hand-edited run_metrics.json) count as 0.
  const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);
  const cacheRead = count(tokens.cacheRead);
  const uncachedInput = Math.max(0, count(tokens.input) - cacheRead);
  return Math.round(uncachedInput + count(tokens.output) + cacheRead * CACHE_READ_BUDGET_WEIGHT);
}

/** Returns a positive finite integer, or undefined for anything else. */
export function parseTokenBudget(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  return n > 0 ? n : undefined;
}

/**
 * Resolves the effective budget. A defined task value wins, so a task value of
 * 0 (or any invalid value) means unlimited even when the project has a limit.
 * Otherwise the project value applies. undefined means no budget.
 */
export function resolveTokenBudget(
  taskMetadata?: { tokenBudget?: number },
  projectSettings?: { tokenBudget?: number }
): number | undefined {
  if (taskMetadata?.tokenBudget !== undefined && taskMetadata.tokenBudget !== null) {
    return parseTokenBudget(taskMetadata.tokenBudget);
  }
  return parseTokenBudget(projectSettings?.tokenBudget);
}

/** Percent of the limit used, rounded down. 0 when there is no valid limit. */
export function budgetPercent(used: number, limit?: number): number {
  if (!limit || limit <= 0 || !Number.isFinite(limit)) return 0;
  return Math.max(0, Math.floor((used / limit) * 100));
}

/**
 * Normalises a per-task budget override. 0 is kept (explicit "no limit for
 * this task"), a positive number is floored, anything else is dropped so the
 * task inherits the project default.
 */
export function normalizeTaskTokenBudget(value: unknown): number | undefined {
  if (value === 0) return 0;
  return parseTokenBudget(value);
}

/** Parses the task form field text: blank or invalid -> undefined (inherit), "0" -> 0 (no limit). */
export function parseTokenBudgetText(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  return normalizeTaskTokenBudget(Number(trimmed));
}
