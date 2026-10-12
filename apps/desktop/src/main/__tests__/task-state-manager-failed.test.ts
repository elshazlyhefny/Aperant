/**
 * zeenha fork: when the machine enters `error`, a run that did no work is
 * emitted and persisted as Failed (status 'error') with its reason; a run that
 * did work stays Human Review "errors".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Task } from '../../shared/types';

const sends: unknown[][] = [];
vi.mock('../ipc-handlers/utils', () => ({
  safeSendToRenderer: (_getWindow: unknown, ...args: unknown[]) => sends.push(args),
}));
const persisted: unknown[][] = [];
vi.mock('../ipc-handlers/task/plan-file-utils', () => ({
  getPlanPath: () => '/p/implementation_plan.json',
  persistPlanStatusAndReasonSync: (...args: unknown[]) => persisted.push(args),
}));
vi.mock('../worktree-paths', () => ({ findTaskWorktree: () => null }));
vi.mock('fs', () => ({ existsSync: () => false }));

const facts = {
  subtasks: [] as Array<{ status?: string }>,
  hasCodeChanges: false as boolean | null,
  reason: undefined as string | undefined,
};
vi.mock('../task-failure-facts', () => ({
  taskSpecDirs: () => ['/p'],
  readSubtaskStatuses: () => facts.subtasks,
  taskHasCodeChanges: () => facts.hasCodeChanges,
  readFailureReason: () => facts.reason,
}));

import { TaskStateManager } from '../task-state-manager';

const task = { id: 't1', specId: '001-x', projectId: 'p1', title: 'x', description: '', status: 'backlog', subtasks: [], logs: [], createdAt: new Date(), updatedAt: new Date() } as Task;
const project = { id: 'p1', path: '/proj', autoBuildPath: '.auto-claude' } as Project;

function fail(manager: TaskStateManager, error = 'Plan validation failed') {
  manager.handleTaskEvent('t1', { type: 'PLANNING_STARTED', sequence: 1 } as never, task, project);
  manager.handleTaskEvent('t1', { type: 'PLANNING_FAILED', error, recoverable: true, sequence: 2 } as never, task, project);
}

const lastSend = () => sends[sends.length - 1];
const lastPersist = () => persisted[persisted.length - 1];

beforeEach(() => {
  sends.length = 0;
  persisted.length = 0;
  facts.subtasks = [];
  facts.hasCodeChanges = false;
  facts.reason = undefined;
});

describe('TaskStateManager entering error', () => {
  it('emits and persists Failed with the machine error as the reason', () => {
    const manager = new TaskStateManager();
    manager.configure(() => ({}) as never);
    fail(manager);
    // [channel, taskId, status, projectId, reviewReason, failureReason]: the reason is sent only for Failed
    expect(lastSend()).toEqual(['task:statusChange', 't1', 'error', 'p1', undefined, 'Plan validation failed']);
    // [planPath, status, reviewReason, projectId, xstateState, executionPhase, failureReason]
    expect(lastPersist()).toEqual(['/p/implementation_plan.json', 'error', undefined, 'p1', 'error', 'failed', 'Plan validation failed']);
  });

  it('falls back to the recorded log reason', () => {
    facts.reason = 'from the log';
    const manager = new TaskStateManager();
    manager.configure(() => ({}) as never);
    fail(manager, '  ');
    expect(lastSend()?.[5]).toBe('from the log');
  });

  it('keeps Human Review "errors" when a subtask was completed', () => {
    facts.subtasks = [{ status: 'completed' }];
    const manager = new TaskStateManager();
    manager.configure(() => ({}) as never);
    fail(manager);
    expect(lastSend()).toEqual(['task:statusChange', 't1', 'human_review', 'p1', 'errors']);
  });

  it('keeps Human Review "errors" when the workspace has changes or they are unknown', () => {
    for (const changes of [true, null]) {
      facts.hasCodeChanges = changes;
      const manager = new TaskStateManager();
      manager.configure(() => ({}) as never);
      fail(manager);
      expect(lastSend()?.[2]).toBe('human_review');
    }
  });

  it('restores a Failed task from disk into the error state, so Retry resumes coding', () => {
    const manager = new TaskStateManager();
    manager.configure(() => ({}) as never);
    const failed = { ...task, status: 'error', failureReason: 'x', subtasks: [{ id: 's', title: '', description: '', status: 'pending', files: [] }] } as Task;
    manager.handleUiEvent('t1', { type: 'USER_RESUMED' }, failed, project);
    expect(manager.getCurrentState('t1')).toBe('coding');
    expect(lastSend()?.[2]).toBe('in_progress');
    // leaving error clears the persisted reason (xstateState coding, no reason)
    expect(lastPersist()?.[4]).toBe('coding');
    expect(lastPersist()?.[6]).toBeUndefined();
  });
});
