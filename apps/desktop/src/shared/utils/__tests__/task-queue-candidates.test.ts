/**
 * zeenha fork: queue candidate selection skips tasks held by dependencies.
 */
import { describe, expect, it } from 'vitest';
import type { Task } from '../../types';
import { pickNextEligibleQueuedTask } from '../task-dependencies';

function mk(id: string, createdAt: number, o: Partial<Task> & { deps?: string[] } = {}): Task {
  const { deps, ...rest } = o;
  return {
    id,
    specId: `spec-${id}`,
    projectId: 'p',
    title: `Task ${id}`,
    description: '',
    status: 'queue',
    subtasks: [],
    logs: [],
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
    ...rest,
    metadata: { ...(rest.metadata ?? {}), ...(deps ? { taskDependencies: deps } : {}) },
  };
}

describe('pickNextEligibleQueuedTask', () => {
  it('promotes a newer eligible task when the oldest is held', () => {
    const tasks = [mk('dep', 1, { status: 'in_progress' }), mk('old', 2, { deps: ['dep'] }), mk('new', 3)];
    expect(pickNextEligibleQueuedTask(tasks)?.id).toBe('new');
  });

  it('keeps the dependent queued across passes while its dependency failed', () => {
    const tasks = [mk('dep', 1, { status: 'human_review', reviewReason: 'errors' }), mk('child', 2, { deps: ['dep'] })];
    for (let i = 0; i < 12; i++) {
      expect(pickNextEligibleQueuedTask(tasks)).toBeUndefined();
    }
  });

  it('promotes the dependent once the dependency is done', () => {
    const tasks = [mk('dep', 1, { status: 'done' }), mk('child', 2, { deps: ['dep'] })];
    expect(pickNextEligibleQueuedTask(tasks)?.id).toBe('child');
  });

  it('does not treat held tasks as failures: only excludeIds are skipped', () => {
    const tasks = [mk('dep', 1, { status: 'in_progress' }), mk('held', 2, { deps: ['dep'] }), mk('a', 3), mk('b', 4)];
    const attempted = new Set<string>();
    expect(pickNextEligibleQueuedTask(tasks, attempted)?.id).toBe('a');
    expect(attempted.size).toBe(0);
    attempted.add('a');
    expect(pickNextEligibleQueuedTask(tasks, attempted)?.id).toBe('b');
  });
});
