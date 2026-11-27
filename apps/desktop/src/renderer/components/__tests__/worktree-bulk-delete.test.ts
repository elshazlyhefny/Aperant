import { describe, expect, it } from 'vitest';
import {
  type BulkDeleteAttempt,
  buildBulkDeleteReport,
  parseSelectionId,
  retainFailedIds,
  summarizeAttempts,
  taskWorktreeDisplayName
} from '../worktree-bulk-delete';

const failedTerminal: BulkDeleteAttempt = {
  id: 'terminal:bar',
  kind: 'terminal',
  name: 'bar',
  outcome: 'failed',
  reason: 'Branch checked out elsewhere'
};
const failedTask: BulkDeleteAttempt = {
  id: 'task:042-foo',
  kind: 'task',
  name: 'Fix foo (042-foo)',
  outcome: 'failed',
  reason: 'Locked by another process'
};
const deletedTask: BulkDeleteAttempt = {
  id: 'task:043-cleanup',
  kind: 'task',
  name: '043-cleanup',
  outcome: 'deleted'
};
const disappearedTerminal: BulkDeleteAttempt = {
  id: 'terminal:gone',
  kind: 'terminal',
  name: 'gone',
  outcome: 'failed'
};

const attempts = [failedTerminal, deletedTask, disappearedTerminal, failedTask];

describe('parseSelectionId', () => {
  it.each([
    ['task:042-foo', { kind: 'task', key: '042-foo' }],
    ['terminal:bar', { kind: 'terminal', key: 'bar' }],
    ['other:bar', null]
  ])('parses %s', (id, expected) => {
    expect(parseSelectionId(id)).toEqual(expected);
  });
});

describe('taskWorktreeDisplayName', () => {
  it('includes the task title and spec name when a title exists', () => {
    expect(taskWorktreeDisplayName('042-foo', 'Fix foo')).toBe('Fix foo (042-foo)');
  });

  it('uses the spec name alone when no title exists', () => {
    expect(taskWorktreeDisplayName('042-foo')).toBe('042-foo');
  });
});

describe('summarizeAttempts', () => {
  it('counts both outcomes and lists the failed attempts in order', () => {
    expect(summarizeAttempts(attempts)).toEqual({
      deletedCount: 1,
      failedCount: 3,
      failed: [failedTerminal, disappearedTerminal, failedTask]
    });
  });
});

describe('retainFailedIds', () => {
  it('keeps only failures still present in the matching list, in attempt order', () => {
    const freshTaskSpecNames = new Set(['042-foo', '043-cleanup', 'gone']);
    expect(retainFailedIds(attempts, freshTaskSpecNames, ['bar'])).toEqual([
      failedTerminal.id,
      failedTask.id
    ]);
  });
});

describe('buildBulkDeleteReport', () => {
  it('retains failures from a successful refresh without changing the attempt counts', () => {
    expect(buildBulkDeleteReport(attempts, {
      ok: true,
      taskSpecNames: ['042-foo', '043-cleanup'],
      terminalNames: ['bar']
    })).toEqual({
      attempts,
      deletedCount: 1,
      failedCount: 3,
      refreshFailed: false,
      retainedFailedIds: [failedTerminal.id, failedTask.id]
    });
  });

  it('records a refresh error and does not retain any IDs', () => {
    expect(buildBulkDeleteReport(attempts, { ok: false, error: 'Refresh failed' })).toEqual({
      attempts,
      deletedCount: 1,
      failedCount: 3,
      refreshFailed: true,
      refreshError: 'Refresh failed',
      retainedFailedIds: []
    });
  });
});
