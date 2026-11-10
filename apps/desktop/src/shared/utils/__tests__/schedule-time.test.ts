import { describe, expect, it } from 'vitest';
import { advancePast, computeNextRun, MAX_DUE_COUNT, validateCadence } from '../schedule-time';

const H = 3_600_000;
const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

describe('computeNextRun', () => {
  it('daily: later today, else tomorrow', () => {
    expect(computeNextRun({ kind: 'daily', time: '09:00' }, local(2026, 3, 10, 8))).toBe(local(2026, 3, 10, 9));
    expect(computeNextRun({ kind: 'daily', time: '09:00' }, local(2026, 3, 10, 9))).toBe(local(2026, 3, 11, 9));
  });

  it('weekly: picks the next selected day, across a week boundary', () => {
    // 2026-03-10 is a Tuesday (2)
    const c = { kind: 'weekly' as const, days: [1], time: '07:30' };
    expect(computeNextRun(c, local(2026, 3, 10, 12))).toBe(local(2026, 3, 16, 7, 30));
    const sun = { kind: 'weekly' as const, days: [0, 6], time: '10:00' };
    expect(computeNextRun(sun, local(2026, 3, 14, 11))).toBe(local(2026, 3, 15, 10));
  });

  it('interval: after + every', () => {
    expect(computeNextRun({ kind: 'interval', everyMinutes: 60 }, 1000)).toBe(1000 + H);
  });
});

describe('advancePast', () => {
  it('interval catch-up keeps the grid', () => {
    const due = 1_000_000;
    const now = due + 5 * H;
    const r = advancePast({ kind: 'interval', everyMinutes: 60 }, due, now);
    expect(r.dueCount).toBeGreaterThanOrEqual(5);
    expect(r.dueCount).toBeLessThanOrEqual(6);
    expect(r.nextRunAt).toBeGreaterThan(now);
    expect((r.nextRunAt - due) % H).toBe(0);
  });

  it('daily counts missed days', () => {
    const c = { kind: 'daily' as const, time: '09:00' };
    const r = advancePast(c, local(2026, 3, 10, 9), local(2026, 3, 12, 10));
    expect(r.dueCount).toBe(3);
    expect(r.nextRunAt).toBe(local(2026, 3, 13, 9));
  });

  it('returns 0 when not yet due', () => {
    expect(advancePast({ kind: 'interval', everyMinutes: 60 }, 5000, 1000)).toEqual({ dueCount: 0, nextRunAt: 5000 });
  });

  it('caps the count', () => {
    const r = advancePast({ kind: 'interval', everyMinutes: 15 }, 0, 100_000 * 15 * 60_000);
    expect(r.dueCount).toBe(MAX_DUE_COUNT);
    expect(r.nextRunAt).toBeGreaterThan(100_000 * 15 * 60_000);
  });
});

describe('validateCadence', () => {
  it('accepts valid cadences', () => {
    expect(validateCadence({ kind: 'daily', time: '23:59' }).ok).toBe(true);
    expect(validateCadence({ kind: 'weekly', days: [0, 3], time: '00:00' }).ok).toBe(true);
    expect(validateCadence({ kind: 'interval', everyMinutes: 15 }).ok).toBe(true);
  });

  it('rejects invalid cadences', () => {
    expect(validateCadence({ kind: 'daily', time: '24:00' }).ok).toBe(false);
    expect(validateCadence({ kind: 'daily', time: '9:00' }).ok).toBe(false);
    expect(validateCadence({ kind: 'weekly', days: [], time: '09:00' }).ok).toBe(false);
    expect(validateCadence({ kind: 'weekly', days: [1, 1], time: '09:00' }).ok).toBe(false);
    expect(validateCadence({ kind: 'weekly', days: [7], time: '09:00' }).ok).toBe(false);
    expect(validateCadence({ kind: 'interval', everyMinutes: 14 }).ok).toBe(false);
    expect(validateCadence({ kind: 'interval', everyMinutes: 30.5 }).ok).toBe(false);
  });
});
