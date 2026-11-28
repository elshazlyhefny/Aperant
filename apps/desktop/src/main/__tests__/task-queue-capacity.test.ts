/**
 * zeenha fork: the queue's account capacity gate (checkCapacity, cooldown after
 * account_required / rate-limit stops, backoff and retry timers).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Task } from '../../shared/types';

vi.mock('../log-port', () => ({
  appLogPort: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}));

import {
  CAPACITY_BACKOFF_BASE_MS,
  CAPACITY_BACKOFF_MAX_MS,
  TaskQueueManager,
  capacityStopFor,
  type CapacityCheckResult,
} from '../task-queue-manager';

let seq = 0;
function makeTask(id: string, status: string): Task {
  return {
    id,
    specId: id,
    projectId: 'p1',
    title: id,
    description: '',
    status,
    subtasks: [],
    logs: [],
    createdAt: new Date(1000 + seq++),
    updatedAt: new Date(),
  } as unknown as Task;
}

const project = { id: 'p1', name: 'p1', path: '/tmp/p1', settings: { maxParallelTasks: 2 } } as unknown as Project;

function setup(tasks: Task[], checkCapacity?: (projectId: string, task: Task) => Promise<CapacityCheckResult>) {
  const promote = vi.fn(async (taskId: string) => {
    const t = tasks.find((x) => x.id === taskId);
    if (t) t.status = 'in_progress' as Task['status'];
    return { success: true };
  });
  const emitState = vi.fn();
  const mgr = new TaskQueueManager({
    getProjects: () => [project],
    getTasks: () => tasks,
    promote,
    emitState,
    ...(checkCapacity ? { checkCapacity } : {}),
  });
  return { mgr, promote, emitState };
}

const NOW = new Date('2026-11-28T10:00:00Z').getTime();

describe('TaskQueueManager capacity gate', () => {
  let mgr: TaskQueueManager | undefined;

  beforeEach(() => {
    seq = 0;
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    mgr?.dispose();
    mgr = undefined;
    vi.useRealTimers();
  });

  it('promotes nothing while capacity is blocked, then promotes when the retry timer fires', async () => {
    const tasks = [makeTask('q1', 'queue'), makeTask('q2', 'queue')];
    let blocked = true;
    const check = vi.fn(async (): Promise<CapacityCheckResult> =>
      blocked ? { ok: false, reason: 'All accounts are rate limited', retryAt: NOW + 5 * 60_000 } : { ok: true }
    );
    const s = setup(tasks, check);
    mgr = s.mgr;

    await mgr.requestProcess('p1');
    expect(s.promote).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledTimes(1);
    const state = mgr.getState('p1');
    expect(state.capacityBlockedUntil).toBe(NOW + 5 * 60_000);
    expect(state.capacityBlockedReason).toBe('All accounts are rate limited');
    expect(state.capacityRetryEstimated).toBe(false);
    // A blocked task is not a failed one
    expect(state.skippedTaskIds).toEqual([]);
    expect(s.emitState).toHaveBeenLastCalledWith('p1', expect.objectContaining({ capacityBlockedUntil: NOW + 5 * 60_000 }));

    // Another pass during the wait neither promotes nor re-checks
    await mgr.requestProcess('p1');
    expect(check).toHaveBeenCalledTimes(1);
    expect(s.promote).not.toHaveBeenCalled();

    blocked = false;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(s.promote.mock.calls.map((c) => c[0])).toEqual(['q1', 'q2']);
    expect(mgr.getState('p1').capacityBlockedUntil).toBeUndefined();
  });

  it('backs off 1, 2, 4 ... 30 minutes when no reset time is known', async () => {
    const tasks = [makeTask('q1', 'queue')];
    const check = vi.fn(async (): Promise<CapacityCheckResult> => ({ ok: false, reason: 'limited' }));
    const s = setup(tasks, check);
    mgr = s.mgr;

    await mgr.requestProcess('p1');
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      const until = mgr.getState('p1').capacityBlockedUntil as number;
      expect(mgr.getState('p1').capacityRetryEstimated).toBe(true);
      delays.push(until - Date.now());
      await vi.advanceTimersByTimeAsync(until - Date.now());
    }
    const minute = CAPACITY_BACKOFF_BASE_MS;
    expect(delays).toEqual([minute, 2 * minute, 4 * minute, 8 * minute, 16 * minute, CAPACITY_BACKOFF_MAX_MS, CAPACITY_BACKOFF_MAX_MS]);
    expect(s.promote).not.toHaveBeenCalled();
  });

  it('resets the backoff once a task gets past the account', async () => {
    const tasks = [makeTask('q1', 'queue'), makeTask('q2', 'queue')];
    const check = vi.fn(async (): Promise<CapacityCheckResult> => ({ ok: false, reason: 'limited' }));
    const s = setup(tasks, check);
    mgr = s.mgr;

    await mgr.requestProcess('p1');
    await vi.advanceTimersByTimeAsync(CAPACITY_BACKOFF_BASE_MS);
    expect(mgr.getState('p1').capacityBlockedUntil).toBe(Date.now() + 2 * CAPACITY_BACKOFF_BASE_MS);

    // A task elsewhere finished normally: capacity exists, the backoff starts over
    await mgr.onTaskStatusChanged('other', 'human_review', 'p1');
    await vi.advanceTimersByTimeAsync(2 * CAPACITY_BACKOFF_BASE_MS);
    expect(mgr.getState('p1').capacityBlockedUntil).toBe(Date.now() + CAPACITY_BACKOFF_BASE_MS);
  });

  it('cools down after a task pauses with account_required instead of promoting the next task', async () => {
    const tasks = [makeTask('r1', 'in_progress'), makeTask('r2', 'in_progress'), makeTask('q1', 'queue'), makeTask('q2', 'queue')];
    const s = setup(tasks);
    mgr = s.mgr;

    tasks[0].status = 'human_review' as Task['status'];
    const stop = capacityStopFor('human_review', 'account_required', 'The planning phase stopped (rate_limited).');
    expect(stop).toBeDefined();
    await mgr.onTaskStatusChanged('r1', 'human_review', 'p1', stop);
    expect(s.promote).not.toHaveBeenCalled();
    expect(mgr.getState('p1').capacityBlockedUntil).toBe(NOW + CAPACITY_BACKOFF_BASE_MS);

    // The second running task hits the same limit: one shared cooldown, no growth
    tasks[1].status = 'human_review' as Task['status'];
    await mgr.onTaskStatusChanged('r2', 'human_review', 'p1', stop);
    expect(mgr.getState('p1').capacityBlockedUntil).toBe(NOW + CAPACITY_BACKOFF_BASE_MS);
    expect(s.promote).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(CAPACITY_BACKOFF_BASE_MS);
    expect(s.promote.mock.calls.map((c) => c[0])).toEqual(['q1', 'q2']);
  });

  it('a rate-limit failure with a named reset waits until that reset', async () => {
    const tasks = [makeTask('r1', 'in_progress'), makeTask('q1', 'queue')];
    const s = setup(tasks);
    mgr = s.mgr;
    tasks[0].status = 'error' as Task['status'];
    const stop = capacityStopFor('error', undefined, 'Claude AI usage limit reached|' + Math.floor((NOW + 20 * 60_000) / 1000));
    await mgr.onTaskStatusChanged('r1', 'error', 'p1', stop);
    expect(mgr.getState('p1')).toMatchObject({ capacityBlockedUntil: NOW + 20 * 60_000, capacityRetryEstimated: false });
    expect(s.promote).not.toHaveBeenCalled();
  });

  it('caps a reported reset far away at the backoff maximum', async () => {
    const tasks = [makeTask('r1', 'in_progress'), makeTask('q1', 'queue')];
    const s = setup(tasks);
    mgr = s.mgr;
    tasks[0].status = 'human_review' as Task['status'];
    await mgr.onTaskStatusChanged('r1', 'human_review', 'p1', { reason: 'weekly limit', retryAt: NOW + 3 * 86_400_000 });
    expect(mgr.getState('p1').capacityBlockedUntil).toBe(NOW + CAPACITY_BACKOFF_MAX_MS);
  });

  it('treats a throwing capacity check as ok', async () => {
    const tasks = [makeTask('q1', 'queue')];
    const s = setup(tasks, async () => {
      throw new Error('boom');
    });
    mgr = s.mgr;
    await mgr.requestProcess('p1');
    expect(s.promote).toHaveBeenCalledTimes(1);
  });

  it('dispose clears the retry timer', async () => {
    const tasks = [makeTask('q1', 'queue')];
    const check = vi.fn(async (): Promise<CapacityCheckResult> => ({ ok: false, reason: 'limited' }));
    const s = setup(tasks, check);
    mgr = s.mgr;
    await mgr.requestProcess('p1');
    mgr.dispose();
    await vi.advanceTimersByTimeAsync(CAPACITY_BACKOFF_MAX_MS);
    expect(check).toHaveBeenCalledTimes(1);
  });
});

describe('capacityStopFor', () => {
  it('flags account pauses and rate-limit failures only', () => {
    expect(capacityStopFor('human_review', 'account_required')).toMatchObject({ reason: expect.any(String) });
    expect(capacityStopFor('error', undefined, '429 Too Many Requests')).toBeDefined();
    expect(capacityStopFor('error', undefined, 'TypeError: x is undefined')).toBeUndefined();
    expect(capacityStopFor('human_review', 'completed')).toBeUndefined();
  });
});
