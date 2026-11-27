/**
 * zeenha fork: session metrics cannot show time spent waiting to start or resume.
 * Keep a separate, local log of task status changes so desktop and daemon can
 * measure the same queue-to-QA-passed window without changing run_metrics.json.
 * Recording is best effort and must never affect task execution.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  DeliveryTimingEvent,
  DeliveryTimingResult,
  DeliveryTimingSegments,
  DeliveryTimingSource,
} from '../../../shared/types/run-metrics';
import { writeFileAtomicSync } from '../../utils/atomic-file';

export const DELIVERY_TIMING_FILE = 'delivery_timing.json';
export const MAX_DELIVERY_TIMING_EVENTS = 500;

const PROCESS_INSTANCE = randomBytes(6).toString('hex');
const PRE_START_STATUSES = new Set(['', 'backlog', 'pending', 'queue', 'queued']);

export type DeliveryTimingState =
  | { state: 'ok'; events: DeliveryTimingEvent[] }
  | { state: 'missing' }
  | { state: 'corrupt' };

function isTimingEvent(event: unknown): event is DeliveryTimingEvent {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return false;
  const { at, status } = event as Partial<DeliveryTimingEvent>;
  return typeof at === 'string' && typeof status === 'string';
}

function parseTimingState(raw: string): DeliveryTimingState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: 'corrupt' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { state: 'corrupt' };
  const events = (parsed as { events?: unknown }).events;
  if (!Array.isArray(events)) return { state: 'corrupt' };
  const valid = events.filter(isTimingEvent);
  return valid.length === 0 ? { state: 'missing' } : { state: 'ok', events: valid };
}

export async function readDeliveryTimingState(specDir: string): Promise<DeliveryTimingState> {
  try {
    return parseTimingState(await readFile(join(specDir, DELIVERY_TIMING_FILE), 'utf-8'));
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'corrupt' };
  }
}

function existingEvents(path: string): DeliveryTimingEvent[] {
  try {
    const state = parseTimingState(readFileSync(path, 'utf-8'));
    return state.state === 'ok' ? state.events : [];
  } catch {
    return [];
  }
}

type DeliveryTimingInput = Pick<DeliveryTimingEvent, 'status' | 'reviewReason' | 'from' | 'pause'> & {
  interrupted?: boolean;
  source: DeliveryTimingSource;
};

export function recordDeliveryTimingEvent(
  specDir: string | undefined,
  input: DeliveryTimingInput,
  options?: { instance?: string }
): void {
  try {
    if (!specDir || !existsSync(specDir)) return;
    const path = join(specDir, DELIVERY_TIMING_FILE);
    const events = existingEvents(path);
    // Preserve the earliest events, which contain the first cycle being measured.
    if (events.length >= MAX_DELIVERY_TIMING_EVENTS) return;

    const { status, reviewReason, from, pause, interrupted, source } = input;
    const instance = options?.instance ?? PROCESS_INSTANCE;
    const last = events.at(-1);
    if (
      last &&
      !interrupted &&
      last.status === status &&
      last.reviewReason === reviewReason &&
      last.pause === pause &&
      last.instance === instance
    ) return;

    events.push({
      at: new Date(Date.now()).toISOString(),
      status,
      reviewReason,
      from,
      pause,
      ...(interrupted ? { interrupted: true } : {}),
      source,
      instance,
    });
    writeFileAtomicSync(path, `${JSON.stringify({ version: 1, events }, null, 2)}\n`);
  } catch {
    // Timing data is optional and must not interfere with task persistence.
  }
}

export function classifyDeliveryTimingEvent(event: DeliveryTimingEvent) {
  const { status, reviewReason, pause } = event;
  if (pause === 'credential') return 'credentialPause';
  if (pause === 'budget') return 'budgetPause';
  if (status === 'human_review') {
    if (reviewReason === 'account_required') return 'credentialPause';
    if (reviewReason === 'token_budget') return 'budgetPause';
    if (reviewReason === 'completed') return 'reviewReady';
  }
  if (status === 'queue') return 'queued';
  if (status === 'in_progress' || status === 'ai_review') return 'active';
  if (status === 'backlog') return 'idle';
  return 'other';
}

/** Measure only the first cycle, from queue entry or direct start until QA passes. */
export function deriveDeliveryTiming(events: readonly DeliveryTimingEvent[]): DeliveryTimingResult {
  const timeline = events.map((event) => ({ event, ms: Date.parse(event.at), kind: classifyDeliveryTimingEvent(event) }));
  if (timeline.some(({ ms }) => !Number.isFinite(ms))) return { state: 'incomplete', reason: 'invalid_event' };
  // Stable sort preserves write order when multiple transitions share a timestamp.
  timeline.sort((a, b) => a.ms - b.ms);

  const start = timeline.findIndex(({ kind }) => kind === 'queued' || kind === 'active');
  if (start < 0) return { state: 'no_start' };
  const { from } = timeline[0].event;
  if (from !== undefined && !PRE_START_STATUSES.has(from)) return { state: 'incomplete', reason: 'started_mid_run' };
  const end = timeline.findIndex(({ kind }, index) => index > start && kind === 'reviewReady');
  if (end < 0) return { state: 'open' };

  const segments: DeliveryTimingSegments = { queuedMs: 0, activeMs: 0, credentialPauseMs: 0, budgetPauseMs: 0, otherMs: 0 };
  for (let i = start; i < end; i += 1) {
    const cur = timeline[i];
    const next = timeline[i + 1];
    const elapsed = next.ms - cur.ms;
    switch (cur.kind) {
      case 'active':
        if (next.event.instance !== cur.event.instance || next.event.interrupted) {
          return { state: 'incomplete', reason: 'interrupted' };
        }
        segments.activeMs += elapsed;
        break;
      case 'queued': segments.queuedMs += elapsed; break;
      case 'credentialPause': segments.credentialPauseMs += elapsed; break;
      case 'budgetPause': segments.budgetPauseMs += elapsed; break;
      default: segments.otherMs += elapsed;
    }
  }

  return {
    state: 'complete',
    startedAt: timeline[start].event.at,
    reviewReadyAt: timeline[end].event.at,
    totalMs: timeline[end].ms - timeline[start].ms,
    segments,
  };
}

/** Nearest rank on ascending values, where p is a fraction in [0, 1]. */
export function percentileNearestRank(sortedValues: readonly number[], p: number): number | null {
  const rank = Math.max(1, Math.ceil(p * sortedValues.length));
  return sortedValues[rank - 1] ?? null;
}
