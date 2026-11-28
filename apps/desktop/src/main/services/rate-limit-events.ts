/**
 * zeenha fork: Electron-free rules for account rate-limit events.
 *
 * Shared by the desktop recorder (rate-limit-recorder.ts, which writes
 * settings.json) and the headless recorder (headless/rate-limit-state.ts, which
 * writes a file under the project's .auto-claude/), so both keep events the
 * same way and scoreProviderAccount reads them the same way.
 */

import { rateLimitTypeFor } from '../claude-profile/rate-limit-manager';
import type { ClaudeRateLimitEvent } from '../../shared/types';

/** How long an account counts as exhausted when the error named no reset time. */
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 10 * 60_000;

/** At most this many events are kept per account. */
const MAX_EVENTS = 10;

/** An event's reset time in ms (0 when unreadable). Accepts Date, ISO string or ms. */
export function rateLimitEventResetMs(event: ClaudeRateLimitEvent): number {
  const value = event.resetAt as unknown;
  if (typeof value === 'number') return value;
  const ms = new Date(value as string | Date).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/** The reset to record: the named reset when it is in the future, else the default cooldown. */
export function rateLimitResetDate(resetAt: number | null, now: number = Date.now()): Date {
  return new Date(resetAt && resetAt > now ? resetAt : now + DEFAULT_RATE_LIMIT_COOLDOWN_MS);
}

/**
 * Add a rate-limit event and drop events whose reset has passed, so the
 * array never grows without bound.
 */
export function withRateLimitEvent(
  events: ClaudeRateLimitEvent[] | undefined,
  resetAt: Date,
  now: number = Date.now()
): ClaudeRateLimitEvent[] {
  const event: ClaudeRateLimitEvent = {
    type: rateLimitTypeFor(resetAt, now),
    hitAt: new Date(now),
    resetAt,
    resetTimeString: resetAt.toISOString(),
  };
  return [event, ...(events ?? []).filter((e) => rateLimitEventResetMs(e) > now)].slice(0, MAX_EVENTS);
}
