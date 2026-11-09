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
 */

import type { StopCondition, ToolSet } from 'ai';

export interface TokenBudgetGuardOptions {
  /** Token limit; undefined, 0 or negative means no limit */
  limit?: number;
  /** Returns tokens spent by earlier sessions of this task (input + output) */
  readSpentTokens: () => number;
}

/** Minimal usage shape accepted by `commitSegment()` */
export interface BudgetUsage {
  promptTokens?: number;
  completionTokens?: number;
}

export class TokenBudgetGuard {
  private readonly limit: number;
  private readonly readSpentTokens: () => number;
  private baseline = 0;
  private committed = 0;

  constructor(options: TokenBudgetGuardOptions) {
    this.limit = options.limit && options.limit > 0 ? options.limit : 0;
    this.readSpentTokens = options.readSpentTokens;
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
  }

  /** Add a finished stream's tokens so later continuation segments keep counting. */
  commitSegment(usage: BudgetUsage): void {
    this.committed += Math.max(0, (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0));
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
        segment += (step.usage?.inputTokens ?? 0) + (step.usage?.outputTokens ?? 0);
      }
      if (this.isExceeded(segment)) {
        onReached?.();
        return true;
      }
      return false;
    };
  }
}
