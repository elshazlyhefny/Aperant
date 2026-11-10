/**
 * zeenha fork: task-to-task dependency rules (finished, waiting, blocked, cycles).
 */
import { describe, expect, it } from 'vitest';
import type { Task } from '../../types';
import {
  evaluateTaskDependencies,
  findDependencyCycle,
  isDependencyFinished,
  validateTaskDependencies,
} from '../task-dependencies';

function mk(id: string, o: Partial<Task> & { deps?: string[] } = {}): Task {
  const { deps, ...rest } = o;
  return {
    id,
    specId: `spec-${id}`,
    projectId: 'p',
    title: `Task ${id}`,
    description: '',
    status: 'backlog',
    subtasks: [],
    logs: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...rest,
    metadata: { ...(rest.metadata ?? {}), ...(deps ? { taskDependencies: deps } : {}) },
  };
}

describe('isDependencyFinished', () => {
  it('is true only for done', () => {
    expect(isDependencyFinished({ status: 'done' })).toBe(true);
    expect(isDependencyFinished({ status: 'pr_created' })).toBe(false);
    expect(isDependencyFinished({ status: 'human_review' })).toBe(false);
  });
});

describe('evaluateTaskDependencies', () => {
  it('is ready with no dependencies', () => {
    const a = mk('a');
    expect(evaluateTaskDependencies(a, [a])).toEqual({ state: 'ready', blockers: [] });
  });

  it('is ready when the dependency is done', () => {
    const b = mk('b', { status: 'done' });
    const a = mk('a', { deps: ['b'] });
    expect(evaluateTaskDependencies(a, [a, b]).state).toBe('ready');
  });

  it('waits on an unfinished dependency', () => {
    const b = mk('b', { status: 'in_progress' });
    const a = mk('a', { deps: ['b'] });
    const r = evaluateTaskDependencies(a, [a, b]);
    expect(r.state).toBe('waiting');
    expect(r.blockers[0]).toMatchObject({ taskId: 'b', reason: 'not_finished' });
  });

  it('waits with pr_not_merged on a pr_created dependency', () => {
    const b = mk('b', { status: 'pr_created' });
    const a = mk('a', { deps: ['b'] });
    const r = evaluateTaskDependencies(a, [a, b]);
    expect(r.state).toBe('waiting');
    expect(r.blockers[0].reason).toBe('pr_not_merged');
  });

  it('does not treat human_review completed as finished', () => {
    const b = mk('b', { status: 'human_review', reviewReason: 'completed' });
    const a = mk('a', { deps: ['b'] });
    expect(evaluateTaskDependencies(a, [a, b]).state).toBe('waiting');
  });

  it('blocks on a failed dependency', () => {
    const b = mk('b', { status: 'error' });
    const a = mk('a', { deps: ['b'] });
    const r = evaluateTaskDependencies(a, [a, b]);
    expect(r.state).toBe('blocked');
    expect(r.blockers[0].reason).toBe('failed');
  });

  it('blocks on a human_review failed run', () => {
    const b = mk('b', {
      status: 'human_review',
      reviewReason: 'errors',
      executionProgress: { phase: 'failed', phaseProgress: 0, overallProgress: 0 },
    });
    const a = mk('a', { deps: ['b'] });
    expect(evaluateTaskDependencies(a, [a, b]).blockers[0].reason).toBe('failed');
  });

  it('blocks on a deleted dependency', () => {
    const a = mk('a', { deps: ['gone'] });
    const r = evaluateTaskDependencies(a, [a]);
    expect(r.state).toBe('blocked');
    expect(r.blockers[0]).toMatchObject({ taskId: 'gone', reason: 'missing' });
  });

  it('blocks on an archived dependency that is not done', () => {
    const b = mk('b', { status: 'backlog', metadata: { archivedAt: '2026-01-01' } });
    const a = mk('a', { deps: ['b'] });
    const r = evaluateTaskDependencies(a, [a, b]);
    expect(r.state).toBe('blocked');
    expect(r.blockers[0].reason).toBe('archived');
  });

  it('accepts an archived dependency that is done', () => {
    const b = mk('b', { status: 'done', metadata: { archivedAt: '2026-01-01' } });
    const a = mk('a', { deps: ['b'] });
    expect(evaluateTaskDependencies(a, [a, b]).state).toBe('ready');
  });

  it('mixes: blocked wins over waiting', () => {
    const b = mk('b', { status: 'done' });
    const c = mk('c', { status: 'pr_created' });
    const d = mk('d', { status: 'error' });
    const a = mk('a', { deps: ['b', 'c', 'd'] });
    const r = evaluateTaskDependencies(a, [a, b, c, d]);
    expect(r.state).toBe('blocked');
    expect(r.blockers.map((x) => x.reason)).toEqual(['pr_not_merged', 'failed']);
  });

  it('resolves dependencies by id and by specId', () => {
    const b = mk('b', { status: 'done' });
    const byId = mk('a1', { deps: ['b'] });
    const bySpec = mk('a2', { deps: ['spec-b'] });
    expect(evaluateTaskDependencies(byId, [b]).state).toBe('ready');
    expect(evaluateTaskDependencies(bySpec, [b]).state).toBe('ready');
  });
});

describe('findDependencyCycle', () => {
  it('detects a self-dependency', () => {
    const a = mk('a');
    expect(findDependencyCycle('a', ['a'], [a])).toEqual(['a', 'a']);
  });

  it('detects a 2-node cycle', () => {
    const a = mk('a');
    const b = mk('b', { deps: ['a'] });
    const cycle = findDependencyCycle('a', ['b'], [a, b]);
    expect(cycle).toEqual(['a', 'b', 'a']);
  });

  it('detects a 3-node cycle', () => {
    const a = mk('a');
    const b = mk('b', { deps: ['c'] });
    const c = mk('c', { deps: ['a'] });
    const cycle = findDependencyCycle('a', ['b'], [a, b, c]);
    expect(cycle).toEqual(['a', 'b', 'c', 'a']);
  });

  it('does not flag a diamond', () => {
    const d = mk('d');
    const b = mk('b', { deps: ['d'] });
    const c = mk('c', { deps: ['d'] });
    const a = mk('a');
    expect(findDependencyCycle('a', ['b', 'c'], [a, b, c, d])).toBeNull();
  });

  it('detects a cycle through a specId reference', () => {
    const a = mk('a');
    const b = mk('b', { deps: ['spec-a'] });
    expect(findDependencyCycle('a', ['spec-b'], [a, b])).not.toBeNull();
  });

  it('ignores the stored dependencies of the task being edited', () => {
    const a = mk('a', { deps: ['b'] });
    const b = mk('b');
    expect(findDependencyCycle('a', [], [a, b])).toBeNull();
    expect(findDependencyCycle('b', ['a'], [a, b])).toEqual(['b', 'a', 'b']);
  });
});

describe('validateTaskDependencies', () => {
  it('de-duplicates dependencies', () => {
    const a = mk('a');
    const b = mk('b');
    expect(validateTaskDependencies('a', ['b', 'b'], [a, b])).toEqual({ ok: true, deps: ['b'] });
  });

  it('rejects self, unknown and cycle', () => {
    const a = mk('a');
    const b = mk('b', { deps: ['a'] });
    expect(validateTaskDependencies('a', ['a'], [a, b])).toMatchObject({ ok: false, code: 'self' });
    expect(validateTaskDependencies('a', ['zzz'], [a, b])).toEqual({ ok: false, code: 'unknown', ids: ['zzz'] });
    expect(validateTaskDependencies('a', ['b'], [a, b])).toMatchObject({ ok: false, code: 'cycle' });
  });
});
