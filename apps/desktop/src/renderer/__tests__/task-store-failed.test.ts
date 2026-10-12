/**
 * zeenha fork: the store keeps a failed task's reason only while it is
 * failed, and Re-plan discards the plan before starting.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { replanFailedTask, retryFailedTask, useTaskStore } from '../stores/task-store';
import type { Task } from '../../shared/types';

const task = (o: Partial<Task> = {}): Task => ({
  id: 't1', specId: '025-x', projectId: 'p1', title: 'T', description: '', status: 'in_progress',
  subtasks: [{ id: 's1', title: '', description: '', status: 'pending', files: [] }], logs: [],
  createdAt: new Date(), updatedAt: new Date(), ...o,
});

const calls: string[] = [];
beforeEach(() => {
  calls.length = 0;
  useTaskStore.setState({ tasks: [task()], selectedTaskId: null, isLoading: false, error: null });
  (globalThis as { window?: unknown }).window = globalThis;
  (globalThis as unknown as { electronAPI: unknown }).electronAPI = {
    resetTaskPlan: vi.fn(async () => { calls.push('reset'); return { success: true }; }),
    startTask: vi.fn(() => { calls.push('start'); }),
  };
});

const current = () => useTaskStore.getState().tasks[0];

describe('updateTaskStatus failureReason', () => {
  it('keeps the reason while failed and drops it when the task moves on', () => {
    useTaskStore.getState().updateTaskStatus('t1', 'error', undefined, 'boom');
    expect(current().status).toBe('error');
    expect(current().failureReason).toBe('boom');
    useTaskStore.getState().updateTaskStatus('t1', 'in_progress');
    expect(current().failureReason).toBeUndefined();
  });
});

describe('Retry and Re-plan', () => {
  it('Retry starts the task without touching the plan', async () => {
    await retryFailedTask('t1');
    expect(calls).toEqual(['start']);
    expect(current().subtasks).toHaveLength(1);
  });

  it('Re-plan discards the plan, then starts', async () => {
    await replanFailedTask('t1');
    expect(calls).toEqual(['reset', 'start']);
    expect(current().subtasks).toEqual([]);
  });

  it('Re-plan does not start when the plan could not be discarded', async () => {
    (globalThis as unknown as { electronAPI: { resetTaskPlan: unknown } }).electronAPI.resetTaskPlan = vi.fn(async () => ({
      success: false,
      error: 'Only a failed task can be re-planned',
    }));
    const result = await replanFailedTask('t1');
    expect(result).toMatchObject({ success: false, error: 'Only a failed task can be re-planned' });
    expect(calls).toEqual([]);
  });
});
