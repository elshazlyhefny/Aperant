/**
 * zeenha fork: read when a rate limit lifts from a provider error message, so a
 * paused task and the task queue can wait until then instead of guessing.
 *
 * Pure and Electron-free: used by the worker bridge, the build pipeline and the
 * queue. Returns null when the message names no reset time (the caller then
 * falls back to its own default or backoff).
 */

/** A reset further ahead than this is treated as unparsed (weekly limits are at most 7 days). */
const MAX_RESET_AHEAD_MS = 8 * 24 * 60 * 60 * 1000;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const UNIT_MS: Record<string, number> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
};

function to24h(hour: number, ampm: string): number {
  if (ampm === 'pm' && hour < 12) return hour + 12;
  if (ampm === 'am' && hour === 12) return 0;
  return hour;
}

/**
 * Extract the time (ms since epoch) at which a rate limit resets.
 *
 * Understands:
 * - Claude's epoch suffix: "Claude AI usage limit reached|1759874400"
 * - Relative waits: "retry after 30 seconds", "try again in 5 minutes"
 * - Claude reset clock times: "resets 3am", "resets Dec 17 at 6am (Europe/Oslo)"
 *   (read as local time, like the profile usage parser)
 */
export function extractRateLimitResetAt(message: string | null | undefined, now: number = Date.now()): number | null {
  if (!message) return null;
  const text = message.toLowerCase();
  const accept = (ts: number): number | null =>
    Number.isFinite(ts) && ts > now && ts - now <= MAX_RESET_AHEAD_MS ? ts : null;

  const epoch = text.match(/\|(\d{10})(?!\d)/);
  if (epoch) {
    const ts = accept(Number(epoch[1]) * 1000);
    if (ts) return ts;
  }

  const relative = text.match(/(?:retry[- ]after|try again in)[:\s]*(\d+(?:\.\d+)?)\s*([a-z]+)?/);
  if (relative) {
    const unit = relative[2] && UNIT_MS[relative[2]] !== undefined ? UNIT_MS[relative[2]] : 1000;
    const ts = accept(now + Math.round(Number(relative[1]) * unit));
    if (ts) return ts;
  }

  const clock = text.match(
    /resets?\s+(?:at\s+)?(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,|\s+at)?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/
  );
  if (clock) {
    const [, monthName, day, hourText, minuteText = '0', ampm] = clock;
    const hour = to24h(Number(hourText), ampm);
    const minute = Number(minuteText);
    const current = new Date(now);
    const monthIndex = monthName ? MONTHS.indexOf(monthName) : -1;
    if (monthName && monthIndex >= 0) {
      const date = new Date(current.getFullYear(), monthIndex, Number(day), hour, minute);
      if (date.getTime() <= now) date.setFullYear(date.getFullYear() + 1);
      return accept(date.getTime());
    }
    if (!monthName) {
      const date = new Date(current.getFullYear(), current.getMonth(), current.getDate(), hour, minute);
      if (date.getTime() <= now) date.setDate(date.getDate() + 1);
      return accept(date.getTime());
    }
  }

  return null;
}

/**
 * Whether a task failure reason reads as a rate or usage limit, so the queue
 * can cool down instead of starting the next task into the same limit.
 */
export function isRateLimitReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return /rate.?limit|usage limit|limit reached|too many requests|\b429\b/i.test(reason);
}
