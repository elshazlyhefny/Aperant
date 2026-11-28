/**
 * Token Budget Guard
 * ==================
 *
 * zeenha fork: lets a task stop when its total token spend reaches a limit.
 *
 * The guard counts three things:
 * - a baseline of tokens already spent by earlier sessions (re-read from
 *   `run_metrics.json` by the caller via `beginSession()`),
 * - segments that already finished inside this session (`commitSegment()`),
 *   so session continuations keep counting,
 * - the segment currently streaming (passed to `used()` / `isExceeded()`).
 *
 * A guard without a positive limit never reports exceeded.
 *
 * zeenha fork: every count goes through the shared `budgetTokens()`, so cache
 * reads are weighted the same way here as in run_metrics and the UI.
 */

import type { StopCondition, ToolSet } from 'ai';

import { budgetPercent, budgetTokens } from '../../../shared/utils/token-budget';

/** zeenha fork: percent of the limit at which the guard warns once per task run. */
export const BUDGET_WARNING_PERCENT = 80;

export interface TokenBudgetGuardOptions {
  /** Token limit; undefined, 0 or negative means no limit */
  limit?: number;
  /** Returns budget tokens spent by earlier sessions of this task (see `budgetTokens()`) */
  readSpentTokens: () => number;
  /**
   * zeenha fork: called once, the first time usage reaches BUDGET_WARNING_PERCENT
   * of the limit without exceeding it.
   */
  onWarning?: (snapshot: { limit: number; used: number }) => void;
}

/** Minimal usage shape accepted by `commitSegment()` */
export interface BudgetUsage {
  promptTokens?: number;
  completionTokens?: number;
  cacheReadTokens?: number;
}

/** Budget tokens of one session segment (input includes cache reads). */
export function segmentBudgetTokens(usage: BudgetUsage): number {
  return budgetTokens({
    input: usage.promptTokens ?? 0,
    output: usage.completionTokens ?? 0,
    cacheRead: usage.cacheReadTokens ?? 0,
  });
}

/** AI SDK v6 step usage; the Claude Code engine reports cacheReadTokens at the top level. */
interface StepUsage {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number };
  cacheReadTokens?: number;
}

export class TokenBudgetGuard {
  private readonly limit: number;
  private readonly readSpentTokens: () => number;
  private readonly onWarning?: (snapshot: { limit: number; used: number }) => void;
  private baseline = 0;
  private committed = 0;
  private warned = false;

  constructor(options: TokenBudgetGuardOptions) {
    this.limit = options.limit && options.limit > 0 ? options.limit : 0;
    this.readSpentTokens = options.readSpentTokens;
    this.onWarning = options.onWarning;
    this.beginSession();
  }

  /** True when a limit is set */
  get enabled(): boolean {
    return this.limit > 0;
  }

  /** Re-read the spent baseline and drop committed segments. Call once per session, not per continuation. */
  beginSession(): void {
    let spent = 0;
    try {
      spent = this.readSpentTokens();
    } catch {
      spent = 0;
    }
    this.baseline = Number.isFinite(spent) && spent > 0 ? spent : 0;
    this.committed = 0;
    this.checkWarning();
  }

  /** Add a finished stream's tokens so later continuation segments keep counting. */
  commitSegment(usage: BudgetUsage): void {
    this.committed += segmentBudgetTokens(usage);
    this.checkWarning();
  }

  /**
   * zeenha fork: fire `onWarning` once when usage first reaches the warning
   * percent. A jump straight past the limit is left to the budget stop.
   */
  checkWarning(currentSegmentTokens = 0): void {
    if (this.warned || !this.enabled || !this.onWarning) return;
    const used = this.used(currentSegmentTokens);
    if (used >= this.limit || budgetPercent(used, this.limit) < BUDGET_WARNING_PERCENT) return;
    this.warned = true;
    try {
      this.onWarning({ limit: this.limit, used });
    } catch {
      // A warning must never affect a build.
    }
  }

  /** Total tokens used including the segment currently streaming. */
  used(currentSegmentTokens = 0): number {
    return this.baseline + this.committed + Math.max(0, currentSegmentTokens);
  }

  isExceeded(currentSegmentTokens = 0): boolean {
    return this.enabled && this.used(currentSegmentTokens) >= this.limit;
  }

  snapshot(): { limit: number; used: number } {
    return { limit: this.limit, used: this.used() };
  }

  /** Stop condition for `streamText({ stopWhen })`. Evaluated after each finished step. */
  buildStopCondition<TOOLS extends ToolSet = ToolSet>(onReached?: () => void): StopCondition<TOOLS> {
    return ({ steps }) => {
      let segment = 0;
      for (const step of steps) {
        const usage = step.usage as StepUsage | undefined;
        segment += segmentBudgetTokens({
          promptTokens: usage?.inputTokens,
          completionTokens: usage?.outputTokens,
          cacheReadTokens: usage?.inputTokenDetails?.cacheReadTokens ?? usage?.cacheReadTokens,
        });
      }
      if (this.isExceeded(segment)) {
        onReached?.();
        return true;
      }
      this.checkWarning(segment);
      return false;
    };
  }
}
