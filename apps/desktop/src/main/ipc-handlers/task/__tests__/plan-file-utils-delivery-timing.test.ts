import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readDeliveryTimingState } from '../../../ai/logging/delivery-timing';
import type { Task } from '../../../../shared/types';
import * as atomicFile from '../../../utils/atomic-file';
import {
  createPlanIfNotExists,
  persistPlanStatus,
  persistPlanStatusAndReasonSync,
  persistPlanStatusSync,
} from '../plan-file-utils';

vi.mock('../../../project-store', () => ({ projectStore: { invalidateTasksCache: vi.fn() } }));

let dir: string;
const planPath = () => join(dir, 'implementation_plan.json');
const start = Date.parse('2026-01-01T00:00:00.000Z');
const at = (minutes: number) => new Date(start + minutes * 60_000);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plan-delivery-timing-'));
  vi.useFakeTimers();
  vi.setSystemTime(at(0));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const event = (minutes: number, status: string, from?: string, reviewReason?: string) => ({
  at: at(minutes).toISOString(),
  status,
  ...(from === undefined ? {} : { from }),
  ...(reviewReason === undefined ? {} : { reviewReason }),
  source: 'desktop',
  instance: expect.any(String),
});

describe('desktop delivery timing', () => {
  it('records queue entry, execution, AI review and successful QA with their previous statuses', async () => {
    writeFileSync(planPath(), JSON.stringify({ status: 'backlog', phases: [] }));

    expect(await persistPlanStatus(planPath(), 'queue')).toBe(true);
    vi.setSystemTime(at(5));
    expect(persistPlanStatusAndReasonSync(planPath(), 'in_progress')).toBe(true);
    vi.setSystemTime(at(20));
    expect(persistPlanStatusAndReasonSync(planPath(), 'ai_review')).toBe(true);
    vi.setSystemTime(at(25));
    expect(persistPlanStatusAndReasonSync(planPath(), 'human_review', 'completed')).toBe(true);

    expect(await readDeliveryTimingState(dir)).toEqual({
      state: 'ok',
      events: [
        event(0, 'queue', 'backlog'),
        event(5, 'in_progress', 'queue'),
        event(20, 'ai_review', 'in_progress'),
        event(25, 'human_review', 'ai_review', 'completed'),
      ],
    });
  });

  it('records a synchronous status-only write without attributing a stale review reason', async () => {
    writeFileSync(planPath(), JSON.stringify({ status: 'ai_review', reviewReason: 'completed' }));

    expect(persistPlanStatusSync(planPath(), 'human_review')).toBe(true);

    expect(await readDeliveryTimingState(dir)).toEqual({
      state: 'ok',
      events: [event(0, 'human_review', 'ai_review')],
    });
  });

  it('records the initial status when creating a plan, but not when the plan already exists', async () => {
    const task: Task = {
      id: 'task',
      specId: 'task',
      projectId: 'project',
      title: 'Example task',
      description: '',
      status: 'queue',
      subtasks: [],
      logs: [],
      createdAt: at(0),
      updatedAt: at(0),
    };

    await createPlanIfNotExists(planPath(), task, 'queue');
    vi.setSystemTime(at(5));
    await createPlanIfNotExists(planPath(), task, 'in_progress');

    expect(await readDeliveryTimingState(dir)).toEqual({
      state: 'ok',
      events: [event(0, 'queue')],
    });
  });

  it('records a minimal plan without a previous status in the plan’s own directory', async () => {
    const specDir = join(dir, 'worktree', 'spec');
    expect(persistPlanStatusAndReasonSync(join(specDir, 'implementation_plan.json'), 'in_progress')).toBe(true);

    expect(await readDeliveryTimingState(specDir)).toEqual({
      state: 'ok',
      events: [event(0, 'in_progress')],
    });
    expect(await readDeliveryTimingState(dir)).toEqual({ state: 'missing' });
  });

  it('does not record a status when the plan has unrepairable JSON', async () => {
    writeFileSync(planPath(), 'not a plan');

    expect(await persistPlanStatus(planPath(), 'queue')).toBe(false);
    expect(persistPlanStatusSync(planPath(), 'queue')).toBe(false);
    expect(persistPlanStatusAndReasonSync(planPath(), 'in_progress')).toBe(false);

    expect(await readDeliveryTimingState(dir)).toEqual({ state: 'missing' });
  });

  it('does not record if the atomic plan write throws', async () => {
    writeFileSync(planPath(), JSON.stringify({ status: 'backlog' }));
    vi.spyOn(atomicFile, 'writeFileAtomicSync').mockImplementationOnce(() => {
      throw new Error('Plan write failed');
    });

    expect(await persistPlanStatus(planPath(), 'queue')).toBe(false);
    expect(await readDeliveryTimingState(dir)).toEqual({ state: 'missing' });
  });

  it('deduplicates consecutive re-stamps of the same status and review reason', async () => {
    writeFileSync(planPath(), JSON.stringify({ status: 'in_progress' }));

    expect(persistPlanStatusAndReasonSync(planPath(), 'human_review', 'account_required')).toBe(true);
    vi.setSystemTime(at(5));
    expect(persistPlanStatusAndReasonSync(planPath(), 'human_review', 'account_required')).toBe(true);

    expect(await readDeliveryTimingState(dir)).toEqual({
      state: 'ok',
      events: [event(0, 'human_review', 'in_progress', 'account_required')],
    });
  });
});
