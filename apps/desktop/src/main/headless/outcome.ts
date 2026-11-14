/**
 * zeenha fork: classify a headless run from the bridge's task events and exit.
 * Success is only ever reported when QA_PASSED was seen.
 */

export const EXIT_SUCCESS = 0;
export const EXIT_ERROR = 1;
export const EXIT_QA_FAILED = 2;

export interface RunEvent {
  type: string;
  error?: unknown;
  reason?: unknown;
  extra?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RunInput {
  /** Task events in arrival order. */
  events: RunEvent[];
  /** Messages from the bridge's 'error' event. */
  errors?: string[];
  /** Set when the worker exited; absent if the run has not ended. */
  exit?: { code: number | null; signal?: string | null };
  /** Set when the run was aborted by a signal (SIGINT/SIGTERM). */
  abortSignal?: string;
}

export interface RunOutcome {
  kind: 'success' | 'qa_failed' | 'error';
  exitCode: 0 | 1 | 2;
  reason?: string;
  /** Pull request url seen on any event (last one wins). */
  prUrl?: string;
}

function field(event: RunEvent, key: 'error' | 'reason'): string | undefined {
  const direct = event[key];
  if (typeof direct === 'string' && direct) return direct;
  const nested = event.extra?.[key];
  if (typeof nested === 'string' && nested) return nested;
  return undefined;
}

function lastPrUrl(events: RunEvent[]): string | undefined {
  let found: string | undefined;
  for (const e of events) {
    const direct = e.prUrl;
    const nested = e.extra?.prUrl;
    if (typeof direct === 'string' && direct) found = direct;
    if (typeof nested === 'string' && nested) found = nested;
  }
  return found;
}

export function classifyRun(input: RunInput): RunOutcome {
  const outcome = classifyRunBase(input);
  const prUrl = lastPrUrl(input.events);
  return prUrl ? { ...outcome, prUrl } : outcome;
}

function classifyRunBase(input: RunInput): RunOutcome {
  const { events, errors = [], exit, abortSignal } = input;

  if (abortSignal) {
    return { kind: 'error', exitCode: EXIT_ERROR, reason: `aborted by ${abortSignal}` };
  }

  if (events.some((e) => e.type === 'QA_PASSED')) {
    return { kind: 'success', exitCode: EXIT_SUCCESS };
  }

  const qaMax = events.find((e) => e.type === 'QA_MAX_ITERATIONS');
  if (qaMax) {
    const iterations = qaMax.extra?.iteration ?? qaMax.iteration;
    return {
      kind: 'qa_failed',
      exitCode: EXIT_QA_FAILED,
      reason: field(qaMax, 'reason') ?? field(qaMax, 'error') ??
        `QA did not pass${iterations !== undefined ? ` after ${String(iterations)} iteration(s)` : ''}`,
    };
  }

  // zeenha fork: the worker stopped because the task's token budget was reached.
  // It exits cleanly, so without this the run reported no build result.
  const budget = events.find((e) => e.type === 'TOKEN_BUDGET_REACHED');
  if (budget) {
    const used = budget.extra?.used ?? budget.used;
    const limit = budget.extra?.limit ?? budget.limit;
    return {
      kind: 'error',
      exitCode: EXIT_ERROR,
      reason: used !== undefined && limit !== undefined
        ? `token budget reached: ${String(used)} of ${String(limit)} tokens used`
        : 'token budget reached',
    };
  }

  const failed = events.find((e) => e.type === 'PLANNING_FAILED' || e.type === 'CODING_FAILED');
  if (failed) {
    return {
      kind: 'error',
      exitCode: EXIT_ERROR,
      reason: field(failed, 'error') ?? (failed.type === 'PLANNING_FAILED' ? 'planning failed' : 'coding failed'),
    };
  }

  if (errors.length > 0) {
    return { kind: 'error', exitCode: EXIT_ERROR, reason: errors[errors.length - 1] };
  }

  if (exit?.signal) {
    return { kind: 'error', exitCode: EXIT_ERROR, reason: `worker killed by ${exit.signal}` };
  }
  if (exit && exit.code !== 0) {
    return { kind: 'error', exitCode: EXIT_ERROR, reason: `worker exited with code ${exit.code}` };
  }
  return { kind: 'error', exitCode: EXIT_ERROR, reason: 'worker ended without reporting a build result' };
}
