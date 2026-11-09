/**
 * zeenha fork: token budget helpers shared by the main process and renderer.
 */

/**
 * Tokens that count against a budget: input + output.
 *
 * cacheRead and cacheCreation are deliberately ignored. As documented in
 * cli-events.ts, `input` already includes cached input, so the cache fields
 * are a subset of it and adding them would double count.
 */
export function budgetTokens(tokens: {
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
}): number {
  return tokens.input + tokens.output;
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
