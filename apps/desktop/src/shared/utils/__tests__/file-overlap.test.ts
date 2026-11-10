/**
 * zeenha fork: overlap detection for parallel tasks that plan to change the same files.
 */
import { describe, expect, it } from 'vitest';
import type { Task, TaskStatus } from '../../types';
import {
  extractPlannedFiles,
  findFileOverlaps,
  getPlannedFiles,
  isHoldActive,
  normalizePlannedPath,
} from '../file-overlap';

function makeTask(id: string, files: string[][] | null, o: Partial<Task> = {}): Task {
  return {
    id,
    specId: id,
    projectId: 'p1',
    title: `Task ${id}`,
    description: '',
    status: 'in_progress',
    subtasks: (files ?? []).map((f, i) => ({
      id: `${id}-${i}`,
      title: 's',
      description: '',
      status: 'pending',
      files: f,
    })),
    logs: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...o,
  } as Task;
}

describe('normalizePlannedPath', () => {
  it('strips ./, whitespace and converts backslashes', () => {
    expect(normalizePlannedPath(' ./a/b.ts ')).toBe('a/b.ts');
    expect(normalizePlannedPath('a\\b.ts')).toBe('a/b.ts');
  });
});

describe('extractPlannedFiles', () => {
  it('returns the deduped union of files_to_modify and files_to_create', () => {
    expect(
      extractPlannedFiles({ files_to_modify: ['a.ts', 'b.ts'], files_to_create: ['b.ts', 'c.ts'] })
    ).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('ignores missing, non-array and non-string values', () => {
    expect(extractPlannedFiles({})).toEqual([]);
    expect(extractPlannedFiles({ files_to_modify: 'a.ts', files_to_create: [1, null, '', 'x.ts'] })).toEqual(['x.ts']);
  });
});

describe('getPlannedFiles', () => {
  it('returns the deduped normalized union', () => {
    expect(getPlannedFiles(makeTask('a', [['./x.ts', 'y.ts'], ['x.ts']]))).toEqual(['x.ts', 'y.ts']);
  });

  it('is null with no subtasks or no files', () => {
    expect(getPlannedFiles(makeTask('a', null))).toBeNull();
    expect(getPlannedFiles(makeTask('a', [[], []]))).toBeNull();
  });
});

describe('findFileOverlaps', () => {
  it('reports a shared file both ways, naming each other', () => {
    const a = makeTask('a', [['src/x.ts', 'src/only-a.ts']]);
    const b = makeTask('b', [['./src/x.ts']]);
    const map = findFileOverlaps([a, b]);
    expect(map.get('a')).toEqual([{ taskId: 'b', title: 'Task b', files: ['src/x.ts'] }]);
    expect(map.get('b')).toEqual([{ taskId: 'a', title: 'Task a', files: ['src/x.ts'] }]);
  });

  it('has no entry when no file is shared', () => {
    expect(findFileOverlaps([makeTask('a', [['x.ts']]), makeTask('b', [['y.ts']])]).size).toBe(0);
  });

  it('never overlaps tasks with unknown planned files', () => {
    const map = findFileOverlaps([makeTask('a', [['x.ts']]), makeTask('b', null), makeTask('c', [[]])]);
    expect(map.size).toBe(0);
  });

  it('ignores other projects', () => {
    const map = findFileOverlaps([makeTask('a', [['x.ts']]), makeTask('b', [['x.ts']], { projectId: 'p2' })]);
    expect(map.size).toBe(0);
  });

  it('ignores done, error and archived tasks', () => {
    const a = makeTask('a', [['x.ts']]);
    for (const status of ['done', 'error', 'pr_created'] as TaskStatus[]) {
      expect(findFileOverlaps([a, makeTask('b', [['x.ts']], { status })]).size).toBe(0);
    }
    const archived = makeTask('b', [['x.ts']], { metadata: { archivedAt: '2026-01-01' } });
    expect(findFileOverlaps([a, archived]).size).toBe(0);
  });

  it('handles three tasks sharing different files, sorted', () => {
    const a = makeTask('a', [['z.ts', 'x.ts']]);
    const b = makeTask('b', [['x.ts', 'z.ts']]);
    const c = makeTask('c', [['z.ts']]);
    const map = findFileOverlaps([a, b, c]);
    expect(map.get('a')).toEqual([
      { taskId: 'b', title: 'Task b', files: ['x.ts', 'z.ts'] },
      { taskId: 'c', title: 'Task c', files: ['z.ts'] },
    ]);
    expect(map.get('c')).toEqual([
      { taskId: 'a', title: 'Task a', files: ['z.ts'] },
      { taskId: 'b', title: 'Task b', files: ['z.ts'] },
    ]);
  });
});

describe('isHoldActive', () => {
  const held = (blocker: string | undefined) => makeTask('h', [['x.ts']], { metadata: { holdUntilTaskId: blocker } });

  it('is active while the blocker runs', () => {
    expect(isHoldActive(held('b'), [makeTask('b', [['x.ts']])])).toBe(true);
  });

  it('is inactive when the blocker finished', () => {
    for (const status of ['human_review', 'done', 'pr_created'] as TaskStatus[]) {
      expect(isHoldActive(held('b'), [makeTask('b', [['x.ts']], { status })])).toBe(false);
    }
  });

  it('is inactive when the blocker is missing or archived, or no hold is set', () => {
    expect(isHoldActive(held('b'), [])).toBe(false);
    expect(isHoldActive(held('b'), [makeTask('b', null, { metadata: { archivedAt: 'x' } })])).toBe(false);
    expect(isHoldActive(held(undefined), [makeTask('b', null)])).toBe(false);
  });
});
