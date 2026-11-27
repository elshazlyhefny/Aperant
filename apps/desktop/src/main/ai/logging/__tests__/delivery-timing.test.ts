/** zeenha fork: controlled-clock fixtures for the local delivery timing core. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeliveryTimingEvent, DeliveryTimingSegments } from '../../../../shared/types/run-metrics';
import {
  DELIVERY_TIMING_FILE,
  MAX_DELIVERY_TIMING_EVENTS,
  deriveDeliveryTiming,
  percentileNearestRank,
  readDeliveryTimingState,
  recordDeliveryTimingEvent,
} from '../delivery-timing';

const START = Date.parse('2026-06-30T12:00:00.000Z');
const MINUTE = 60_000;
const at = (minute: number) => new Date(START + minute * MINUTE).toISOString();

let specDir: string;
let timingFile: string;

function record(
  minute: number,
  status: string,
  extra: Partial<Parameters<typeof recordDeliveryTimingEvent>[1]> = {},
  instance?: string,
) {
  vi.setSystemTime(new Date(at(minute)));
  recordDeliveryTimingEvent(specDir, { source: 'desktop', ...extra, status }, { instance });
}

async function readEvents(): Promise<DeliveryTimingEvent[]> {
  const timing = await readDeliveryTimingState(specDir);
  if (timing.state !== 'ok') throw new Error(`Expected timing events, got ${timing.state}`);
  return timing.events;
}

const complete = (start: number, end: number, segments: Partial<DeliveryTimingSegments>) => ({
  state: 'complete',
  startedAt: at(start),
  reviewReadyAt: at(end),
  totalMs: (end - start) * MINUTE,
  segments: { queuedMs: 0, activeMs: 0, credentialPauseMs: 0, budgetPauseMs: 0, otherMs: 0, ...segments },
});

beforeEach(() => {
  specDir = mkdtempSync(join(tmpdir(), 'delivery-timing-'));
  timingFile = join(specDir, DELIVERY_TIMING_FILE);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(specDir, { recursive: true, force: true });
});

describe('deriveDeliveryTiming', () => {
  it('measures from queue entry until QA passes, including AI review as active', async () => {
    record(0, 'backlog');
    record(5, 'queue', { from: 'backlog' });
    record(15, 'in_progress');
    record(45, 'ai_review');
    record(60, 'human_review', { reviewReason: 'completed' });

    expect(deriveDeliveryTiming(await readEvents())).toEqual(complete(5, 60, {
      queuedMs: 10 * MINUTE,
      activeMs: 45 * MINUTE,
    }));
  });

  it('counts credential pause once and sums queued and active time across a resume', async () => {
    record(0, 'queue');
    record(5, 'in_progress', {}, 'before-pause');
    record(20, 'human_review', { reviewReason: 'account_required' }, 'before-pause');
    expect(deriveDeliveryTiming(await readEvents())).toEqual({ state: 'open' });

    record(50, 'queue', {}, 'after-pause');
    record(60, 'in_progress', {}, 'after-pause');
    record(80, 'human_review', { reviewReason: 'completed' }, 'after-pause');
    expect(deriveDeliveryTiming(await readEvents())).toEqual(complete(0, 80, {
      queuedMs: 15 * MINUTE,
      activeMs: 35 * MINUTE,
      credentialPauseMs: 30 * MINUTE,
    }));
  });

  it.each([
    { status: 'human_review', timing: { reviewReason: 'token_budget' } },
    { status: 'error', timing: { source: 'daemon', pause: 'budget' } as const },
  ])('counts a budget pause in $status without marking the task review-ready', async ({ status, timing }) => {
    record(0, 'queue');
    record(2, 'in_progress');
    record(12, status, timing);
    expect(deriveDeliveryTiming(await readEvents())).toEqual({ state: 'open' });

    record(42, 'in_progress');
    record(52, 'human_review', { reviewReason: 'completed' });
    expect(deriveDeliveryTiming(await readEvents())).toEqual(complete(0, 52, {
      queuedMs: 2 * MINUTE,
      activeMs: 20 * MINUTE,
      budgetPauseMs: 30 * MINUTE,
    }));
  });

  it.each(['qa_rejected', 'stopped', 'plan_review'])('counts human_review/%s as other', async (reviewReason) => {
    record(0, 'in_progress', { from: 'backlog' });
    record(10, 'human_review', { reviewReason });
    expect(deriveDeliveryTiming(await readEvents())).toEqual({ state: 'open' });

    record(20, 'in_progress');
    record(30, 'human_review', { reviewReason: 'completed' });
    expect(deriveDeliveryTiming(await readEvents())).toEqual(complete(0, 30, {
      activeMs: 20 * MINUTE,
      otherMs: 10 * MINUTE,
    }));
  });

  it('starts at a direct backlog-to-in_progress transition with no queue wait', async () => {
    record(0, 'backlog');
    record(7, 'in_progress', { from: 'backlog' });
    record(12, 'human_review', { reviewReason: 'completed' });
    expect(deriveDeliveryTiming(await readEvents())).toEqual(complete(7, 12, { activeMs: 5 * MINUTE }));
  });

  it.each([
    { instance: 'new', interrupted: false },
    { instance: 'original', interrupted: true },
  ])('rejects an active segment ending with instance=$instance, interrupted=$interrupted', async ({ instance, interrupted }) => {
    record(0, 'queue', {}, 'original');
    record(5, 'in_progress', {}, 'original');
    record(10, 'queue', { interrupted }, instance);
    record(15, 'in_progress', {}, instance);
    record(20, 'human_review', { reviewReason: 'completed' }, instance);
    expect(deriveDeliveryTiming(await readEvents())).toEqual({ state: 'incomplete', reason: 'interrupted' });
  });

  it('allows an instance change while queued', async () => {
    record(0, 'queue', {}, 'old');
    record(4, 'in_progress', {}, 'new');
    record(9, 'human_review', { reviewReason: 'completed' }, 'new');
    expect(deriveDeliveryTiming(await readEvents())).toEqual(complete(0, 9, {
      queuedMs: 4 * MINUTE,
      activeMs: 5 * MINUTE,
    }));
  });

  it('rejects logs that start mid-run', async () => {
    record(0, 'ai_review', { from: 'in_progress' });
    record(5, 'human_review', { reviewReason: 'completed' });
    expect(deriveDeliveryTiming(await readEvents())).toEqual({ state: 'incomplete', reason: 'started_mid_run' });
  });

  it('reports no_start when there is no queued or active event', async () => {
    record(0, 'backlog');
    record(5, 'human_review', { reviewReason: 'completed' });
    expect(deriveDeliveryTiming(await readEvents())).toEqual({ state: 'no_start' });
  });

  it('rejects an invalid timestamp', async () => {
    record(0, 'queue');
    record(5, 'human_review', { reviewReason: 'completed' });
    const events = await readEvents();
    events[0].at = 'invalid date';
    expect(deriveDeliveryTiming(events)).toEqual({ state: 'incomplete', reason: 'invalid_event' });
  });

  it('sorts out-of-order events stably and measures only the first cycle', async () => {
    record(2, 'in_progress');
    record(0, 'queue');
    record(2, 'human_review', { reviewReason: 'completed' });
    record(10, 'in_progress', {}, 'another-cycle');
    record(30, 'human_review', { reviewReason: 'completed' }, 'another-cycle');
    expect(deriveDeliveryTiming(await readEvents())).toEqual(complete(0, 2, { queuedMs: 2 * MINUTE }));
  });
});

describe('recordDeliveryTimingEvent', () => {
  it('dedupes re-stamps, but keeps a changed reason, pause, instance or an interrupted transition', async () => {
    record(0, 'human_review', { from: 'in_progress' }, 'first');
    record(1, 'human_review', { from: 'human_review' }, 'first');
    record(2, 'human_review', { reviewReason: 'account_required' }, 'first');
    record(3, 'human_review', { reviewReason: 'account_required', pause: 'credential' }, 'first');
    record(4, 'human_review', { reviewReason: 'account_required', pause: 'credential' }, 'second');
    record(5, 'human_review', { reviewReason: 'account_required', pause: 'credential', interrupted: true }, 'second');
    expect((await readEvents()).map((event) => event.at)).toEqual([0, 2, 3, 4, 5].map(at));
  });

  it('preserves the earliest events when the cap is reached', async () => {
    const events = Array.from({ length: MAX_DELIVERY_TIMING_EVENTS - 1 }, (_, index) => ({
      at: at(index),
      status: index % 2 === 0 ? 'queue' : 'in_progress',
    }));
    writeFileSync(timingFile, JSON.stringify({ version: 1, events }));
    record(MAX_DELIVERY_TIMING_EVENTS - 1, 'in_progress');
    record(MAX_DELIVERY_TIMING_EVENTS, 'ai_review');
    const recorded = await readEvents();
    expect(recorded).toHaveLength(MAX_DELIVERY_TIMING_EVENTS);
    expect(recorded.slice(0, -1)).toEqual(events);
    expect(recorded.at(-1)?.at).toBe(at(MAX_DELIVERY_TIMING_EVENTS - 1));
  });

  it('does not create a spec directory or throw on a write failure', () => {
    const input = { source: 'desktop', status: 'queue' } as const;
    const absent = join(specDir, 'missing');
    expect(() => recordDeliveryTimingEvent(absent, input)).not.toThrow();
    expect(() => recordDeliveryTimingEvent(undefined, input)).not.toThrow();
    expect(existsSync(absent)).toBe(false);

    writeFileSync(timingFile, 'not a directory');
    expect(() => recordDeliveryTimingEvent(timingFile, input)).not.toThrow();
  });

  it('writes only documented fields using a process instance by default', async () => {
    const metadata = {
      source: 'daemon',
      reviewReason: 'token_budget',
      from: 'in_progress',
      pause: 'budget',
      interrupted: true,
      title: 'not timing data',
    } as const;
    record(1, 'error', metadata);
    record(2, 'queue', { interrupted: false });
    const [pause, queue] = await readEvents();
    expect(Object.keys(pause).sort()).toEqual([
      'at', 'from', 'instance', 'interrupted', 'pause', 'reviewReason', 'source', 'status',
    ]);
    expect(Object.keys(queue).sort()).toEqual(['at', 'instance', 'source', 'status']);
    expect(pause).toMatchObject({ at: at(1), source: 'daemon', interrupted: true, pause: 'budget' });
    expect(pause.instance).toMatch(/^[0-9a-f]{12}$/);
    expect(queue.instance).toBe(pause.instance);
  });

  it('starts a new log if the existing file is corrupt', async () => {
    writeFileSync(timingFile, '{"events":[');
    record(0, 'queue');
    expect(JSON.parse(readFileSync(timingFile, 'utf-8'))).toEqual({ version: 1, events: await readEvents() });
    expect(await readEvents()).toHaveLength(1);
  });
});

describe('readDeliveryTimingState', () => {
  it('distinguishes missing files and empty event lists from corrupt files', async () => {
    expect(await readDeliveryTimingState(specDir)).toEqual({ state: 'missing' });
    writeFileSync(timingFile, JSON.stringify({ events: [null, 2, [], { at: at(0) }] }));
    expect(await readDeliveryTimingState(specDir)).toEqual({ state: 'missing' });
    for (const raw of ['{"events":[', 'null', '[]', '{}', '{"events":"bad"}']) {
      writeFileSync(timingFile, raw);
      expect(await readDeliveryTimingState(specDir)).toEqual({ state: 'corrupt' });
    }
  });

  it('tolerates a newer version and unknown fields and keeps valid events when appending', async () => {
    const event = { at: at(0), status: 'queue', extra: true };
    writeFileSync(timingFile, JSON.stringify({ version: 2, extra: 'ignored', events: [42, { status: 'queue' }, event] }));
    expect(await readEvents()).toEqual([expect.objectContaining({ at: at(0), status: 'queue' })]);
    record(3, 'in_progress');
    expect(await readEvents()).toEqual([
      expect.objectContaining({ at: at(0), status: 'queue' }),
      expect.objectContaining({ at: at(3), status: 'in_progress' }),
    ]);
  });
});

describe('percentileNearestRank', () => {
  it('returns null for no samples and the only value for one sample', () => {
    expect(percentileNearestRank([], 0.5)).toBeNull();
    expect(percentileNearestRank([42], 0.5)).toBe(42);
    expect(percentileNearestRank([42], 0.9)).toBe(42);
  });

  it('returns the fifth and ninth values for p50 and p90 of ten samples', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentileNearestRank(values, 0.5)).toBe(5);
    expect(percentileNearestRank(values, 0.9)).toBe(9);
  });
});
