/**
 * zeenha fork: overlap detection for parallel tasks that plan to change the same files.
 */
import { describe, expect, it } from 'vitest';
import type { Task, TaskStatus } from '../../types';
import {
  buildHoldBlockerTitles,
  columnOverlapEntriesAreEqual,
  extractPlannedFiles,
  findFileOverlaps,
  getOverlapInputKey,
  getPlannedFiles,
  isHoldActive,
  normalizePlannedPath,
  reuseFileOverlaps,
  reuseHoldBlockerTitles,
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

describe('getOverlapInputKey', () => {
  const base = () => [makeTask('a', [['x.ts']]), makeTask('b', [['y.ts']])];

  it('is unchanged by progress, timestamps and logs', () => {
    const before = getOverlapInputKey(base());
    const changed = base().map((t) => ({
      ...t,
      executionProgress: { phase: 'coding', phaseProgress: 50, overallProgress: 50 },
      updatedAt: new Date(5000),
      logs: ['line'],
    })) as Task[];
    expect(getOverlapInputKey(changed)).toBe(before);
  });

  it('changes on status, archivedAt, title, projectId, files and holdUntilTaskId', () => {
    const before = getOverlapInputKey(base());
    const variants: Array<Partial<Task>> = [
      { status: 'queue' },
      { metadata: { archivedAt: '2026-01-01' } },
      { title: 'Other' },
      { projectId: 'p2' },
      { metadata: { holdUntilTaskId: 'b' } },
    ];
    for (const v of variants) {
      const tasks = base();
      tasks[0] = { ...tasks[0], ...v } as Task;
      expect(getOverlapInputKey(tasks)).not.toBe(before);
    }
    expect(getOverlapInputKey([makeTask('a', [['z.ts']]), makeTask('b', [['y.ts']])])).not.toBe(before);
  });
});

describe('reuseFileOverlaps', () => {
  it('returns the identical Map and arrays for equal results', () => {
    const prev = findFileOverlaps([makeTask('a', [['x.ts']]), makeTask('b', [['x.ts']])]);
    const next = findFileOverlaps([makeTask('a', [['x.ts']]), makeTask('b', [['x.ts']])]);
    expect(reuseFileOverlaps(prev, next)).toBe(prev);
    expect(reuseFileOverlaps(undefined, next)).toBe(next);
  });

  it('keeps unchanged arrays when one entry changes', () => {
    const prev = findFileOverlaps([
      makeTask('a', [['x.ts']]),
      makeTask('b', [['x.ts']]),
      makeTask('c', [['z.ts']]),
      makeTask('d', [['z.ts']]),
    ]);
    const next = findFileOverlaps([
      makeTask('a', [['x.ts']]),
      makeTask('b', [['x.ts']]),
      makeTask('c', [['z.ts']]),
      makeTask('d', [['z.ts']], { title: 'Renamed' }),
    ]);
    const merged = reuseFileOverlaps(prev, next);
    expect(merged).not.toBe(prev);
    expect(merged.get('a')).toBe(prev.get('a'));
    expect(merged.get('b')).toBe(prev.get('b'));
    expect(merged.get('c')).toBe(next.get('c'));
    expect(merged.get('c')).not.toBe(prev.get('c'));
    expect(merged.get('d')).toBe(prev.get('d'));
  });
});

describe('buildHoldBlockerTitles', () => {
  it('matches the isHoldActive-based result', () => {
    const held = (id: string, blocker: string) => makeTask(id, null, { metadata: { holdUntilTaskId: blocker } });
    const tasks = [
      makeTask('run', [['x.ts']]),
      makeTask('arch', null, { metadata: { archivedAt: 'x' } }),
      makeTask('fin', null, { status: 'done' }),
      held('h1', 'run'),
      held('h2', 'arch'),
      held('h3', 'fin'),
      held('h4', 'missing'),
    ];
    const expected = new Map<string, string>();
    for (const t of tasks) {
      const id = t.metadata?.holdUntilTaskId;
      if (id && isHoldActive(t, tasks)) expected.set(t.id, tasks.find((x) => x.id === id)?.title ?? '');
    }
    expect(buildHoldBlockerTitles(tasks)).toEqual(expected);
    expect([...buildHoldBlockerTitles(tasks).keys()]).toEqual(['h1']);
  });

  it('reuseHoldBlockerTitles returns prev when identical', () => {
    const prev = new Map([['h', 'T']]);
    expect(reuseHoldBlockerTitles(prev, new Map([['h', 'T']]))).toBe(prev);
    const changed = new Map([['h', 'U']]);
    expect(reuseHoldBlockerTitles(prev, changed)).toBe(changed);
  });
});

describe('columnOverlapEntriesAreEqual', () => {
  it('ignores other columns and detects its own changes', () => {
    const col = [{ id: 'a' }];
    const aList = [{ taskId: 'b', title: 'B', files: ['x.ts'] }];
    const prevO = new Map([['a', aList], ['z', [{ taskId: 'q', title: 'Q', files: ['q'] }]]]);
    const nextO = new Map([['a', aList], ['z', [{ taskId: 'q', title: 'Q2', files: ['q'] }]]]);
    expect(columnOverlapEntriesAreEqual(col, prevO, nextO, undefined, undefined)).toBe(true);
    const changedO = new Map([['a', [{ ...aList[0] }]]]);
    expect(columnOverlapEntriesAreEqual(col, prevO, changedO, undefined, undefined)).toBe(false);
    expect(columnOverlapEntriesAreEqual(col, undefined, new Map(), undefined, undefined)).toBe(true);
    expect(columnOverlapEntriesAreEqual(col, undefined, undefined, new Map([['a', 'T']]), new Map([['a', 'U']]))).toBe(false);
    expect(columnOverlapEntriesAreEqual(col, undefined, undefined, new Map([['z', 'T']]), new Map([['z', 'U']]))).toBe(true);
  });
});
