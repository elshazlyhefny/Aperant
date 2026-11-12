/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Task } from '@shared/types';
import { useStableFileOverlaps } from '../useStableFileOverlaps';

function makeTask(id: string, files: string[], o: Partial<Task> = {}): Task {
  return {
    id,
    specId: id,
    projectId: 'p1',
    title: `Task ${id}`,
    description: '',
    status: 'in_progress',
    subtasks: [{ id: `${id}-0`, title: 's', description: '', status: 'pending', files }],
    logs: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...o,
  } as Task;
}

describe('useStableFileOverlaps', () => {
  it('keeps identity when only progress or updatedAt change', () => {
    const base = [makeTask('a', ['x.ts']), makeTask('b', ['x.ts'])];
    const { result, rerender } = renderHook(({ tasks }) => useStableFileOverlaps(tasks), {
      initialProps: { tasks: base },
    });
    const first = result.current;
    expect(first.fileOverlaps.get('a')).toHaveLength(1);
    const next = base.map((t) => ({
      ...t,
      updatedAt: new Date(5),
      executionProgress: { phase: 'coding', phaseProgress: 1, overallProgress: 1 },
    })) as Task[];
    rerender({ tasks: next });
    expect(result.current.fileOverlaps).toBe(first.fileOverlaps);
    expect(result.current.holdBlockerTitles).toBe(first.holdBlockerTitles);
  });

  it('changes identity when a planned file, status or hold blocker changes', () => {
    const base = [makeTask('a', ['x.ts']), makeTask('b', ['x.ts']), makeTask('c', ['z.ts'])];
    const { result, rerender } = renderHook(({ tasks }) => useStableFileOverlaps(tasks), {
      initialProps: { tasks: base },
    });
    const first = result.current;

    rerender({ tasks: [base[0], makeTask('b', ['y.ts']), base[2]] });
    const afterFiles = result.current;
    expect(afterFiles.fileOverlaps).not.toBe(first.fileOverlaps);
    expect(afterFiles.fileOverlaps.get('a')).toBeUndefined();

    rerender({ tasks: [base[0], makeTask('b', ['x.ts']), base[2]] });
    const restored = result.current;
    expect(restored.fileOverlaps.get('a')).toHaveLength(1);

    rerender({ tasks: [base[0], makeTask('b', ['x.ts'], { status: 'done' }), base[2]] });
    expect(result.current.fileOverlaps).not.toBe(restored.fileOverlaps);

    const held = makeTask('c', ['z.ts'], { metadata: { holdUntilTaskId: 'a' } as Task['metadata'] });
    const before = result.current.holdBlockerTitles;
    rerender({ tasks: [base[0], base[1], held] });
    expect(result.current.holdBlockerTitles).not.toBe(before);
    expect(result.current.holdBlockerTitles.get('c')).toBe('Task a');
  });

  it('keeps per-task arrays of unaffected tasks when another task changes', () => {
    const a = makeTask('a', ['x.ts']);
    const b = makeTask('b', ['x.ts']);
    const c = makeTask('c', ['q.ts', 'w.ts']);
    const d = makeTask('d', ['q.ts']);
    const { result, rerender } = renderHook(({ tasks }) => useStableFileOverlaps(tasks), {
      initialProps: { tasks: [a, b, c, d] },
    });
    const cList = result.current.fileOverlaps.get('c');
    const aList = result.current.fileOverlaps.get('a');
    expect(cList).toBeDefined();

    rerender({ tasks: [a, b, c, makeTask('d', ['q.ts', 'w.ts'])] });
    expect(result.current.fileOverlaps.get('a')).toBe(aList);
    expect(result.current.fileOverlaps.get('c')).not.toBe(cList);
  });
});
