/**
 * zeenha fork: pure schedule-time math in local time. Date setters are used so
 * DST transitions are handled by the platform.
 */

import { MIN_INTERVAL_MINUTES, type ScheduleCadence } from '../types/schedule';

const MINUTE_MS = 60_000;
export const MAX_DUE_COUNT = 10_000;

export type CadenceValidation = { ok: true } | { ok: false; reason: string };

function parseTime(time: string): { h: number; m: number } | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return { h, m };
}

export function validateCadence(cadence: ScheduleCadence): CadenceValidation {
  switch (cadence.kind) {
    case 'daily':
      return parseTime(cadence.time) ? { ok: true } : { ok: false, reason: 'Invalid time, expected HH:MM' };
    case 'weekly': {
      if (!parseTime(cadence.time)) return { ok: false, reason: 'Invalid time, expected HH:MM' };
      if (!Array.isArray(cadence.days) || cadence.days.length === 0) {
        return { ok: false, reason: 'Select at least one day' };
      }
      if (cadence.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
        return { ok: false, reason: 'Days must be integers 0-6' };
      }
      if (new Set(cadence.days).size !== cadence.days.length) {
        return { ok: false, reason: 'Days must be unique' };
      }
      return { ok: true };
    }
    case 'interval':
      if (!Number.isInteger(cadence.everyMinutes) || cadence.everyMinutes < MIN_INTERVAL_MINUTES) {
        return { ok: false, reason: `Interval must be a whole number of at least ${MIN_INTERVAL_MINUTES} minutes` };
      }
      return { ok: true };
    default:
      return { ok: false, reason: 'Unknown cadence' };
  }
}

/** First occurrence strictly after `afterMs`. */
export function computeNextRun(cadence: ScheduleCadence, afterMs: number): number {
  if (cadence.kind === 'interval') {
    return afterMs + cadence.everyMinutes * MINUTE_MS;
  }
  const t = parseTime(cadence.time);
  if (!t) throw new Error('Invalid cadence time');
  const days = cadence.kind === 'weekly' ? new Set(cadence.days) : null;
  const base = new Date(afterMs);
  // 8 days covers every weekly pattern even across DST shifts.
  for (let offset = 0; offset <= 8; offset++) {
    const candidate = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, t.h, t.m, 0, 0);
    if (days && !days.has(candidate.getDay())) continue;
    if (candidate.getTime() > afterMs) return candidate.getTime();
  }
  throw new Error('No next run found');
}

/**
 * Count occurrences from `dueAtMs` up to and including `nowMs` and find the
 * first occurrence after `nowMs`.
 */
export function advancePast(
  cadence: ScheduleCadence,
  dueAtMs: number,
  nowMs: number
): { dueCount: number; nextRunAt: number } {
  if (dueAtMs > nowMs) return { dueCount: 0, nextRunAt: dueAtMs };

  if (cadence.kind === 'interval') {
    const step = cadence.everyMinutes * MINUTE_MS;
    const dueCount = Math.min(MAX_DUE_COUNT, Math.floor((nowMs - dueAtMs) / step) + 1);
    let nextRunAt = dueAtMs + dueCount * step;
    if (nextRunAt <= nowMs) {
      // Capped: jump onto the grid just after now.
      nextRunAt = dueAtMs + (Math.floor((nowMs - dueAtMs) / step) + 1) * step;
    }
    return { dueCount, nextRunAt };
  }

  let dueCount = 1;
  let next = computeNextRun(cadence, dueAtMs);
  while (next <= nowMs && dueCount < MAX_DUE_COUNT) {
    dueCount++;
    next = computeNextRun(cadence, next);
  }
  if (next <= nowMs) next = computeNextRun(cadence, nowMs);
  return { dueCount, nextRunAt: next };
}
