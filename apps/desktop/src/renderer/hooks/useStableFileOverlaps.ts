import { useMemo, useRef } from 'react';
import type { Task } from '@shared/types';
import {
  buildHoldBlockerTitles,
  findFileOverlaps,
  getOverlapInputKey,
  reuseFileOverlaps,
  reuseHoldBlockerTitles,
  type TaskFileOverlap,
} from '@shared/utils/file-overlap';

interface StableFileOverlaps {
  fileOverlaps: Map<string, TaskFileOverlap[]>;
  holdBlockerTitles: Map<string, string>;
}

/**
 * zeenha fork: the task store replaces the tasks array on every progress tick,
 * which used to rebuild both maps and re-render every Kanban column. The maps
 * are recomputed only when an overlap input changes, and keep their identity
 * (and per-task arrays) when the result is structurally equal.
 */
export function useStableFileOverlaps(tasks: Task[]): StableFileOverlaps {
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const previousRef = useRef<StableFileOverlaps | undefined>(undefined);

  const key = getOverlapInputKey(tasks);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tasks are read through a ref on purpose; `key` covers every input that matters
  return useMemo(() => {
    const current = tasksRef.current;
    const previous = previousRef.current;
    const result: StableFileOverlaps = {
      fileOverlaps: reuseFileOverlaps(previous?.fileOverlaps, findFileOverlaps(current)),
      holdBlockerTitles: reuseHoldBlockerTitles(previous?.holdBlockerTitles, buildHoldBlockerTitles(current)),
    };
    previousRef.current = result;
    return result;
  }, [key]);
}
