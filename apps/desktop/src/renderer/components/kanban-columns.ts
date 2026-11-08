/**
 * zeenha fork: which board column a task sits in, and which columns the board
 * shows.
 *
 * The six TASK_STATUS_COLUMNS are the columns a task can be moved into. The
 * Failed column (status 'error': a run that failed before doing any work, see
 * shared/utils/task-failure) is extra: it sits after Human Review, appears only
 * while it holds a task, and nothing can be dropped into it (a task becomes
 * failed only by failing).
 */
import { TASK_STATUS_COLUMNS } from '../../shared/constants';
import type { Task, TaskStatus } from '../../shared/types';
import { canMoveFailedTaskTo } from '../../shared/utils/task-failure';

export const FAILED_COLUMN = 'error' as const;

export type BoardColumn = typeof TASK_STATUS_COLUMNS[number] | typeof FAILED_COLUMN;

/** pr_created tasks show in Done; failed tasks in their own Failed column. */
export function getVisualColumn(status: TaskStatus): BoardColumn {
  if (status === 'pr_created') return 'done';
  return status;
}

/** The columns to render, in order: the Failed column after Human Review while it has tasks. */
export function getBoardColumns(failedTaskCount: number): BoardColumn[] {
  const columns: BoardColumn[] = [];
  for (const column of TASK_STATUS_COLUMNS) {
    columns.push(column);
    if (column === 'human_review' && failedTaskCount > 0) columns.push(FAILED_COLUMN);
  }
  return columns;
}

/**
 * Whether a task in column `from` may be dropped on column `to`. Nothing drops
 * into the Failed column; a Failed task may go only where
 * canMoveFailedTaskTo() allows (not AI Review or Human Review).
 */
export function canDropTask(from: TaskStatus, to: TaskStatus): boolean {
  if (getVisualColumn(to) === FAILED_COLUMN) return false;
  if (getVisualColumn(from) === FAILED_COLUMN) return canMoveFailedTaskTo(to);
  return true;
}

/** Whether a task matches the board search query (case-insensitive; matches title, description or spec ID). */
export function taskMatchesSearch(
  task: Pick<Task, 'title' | 'description' | 'specId'>,
  query: string
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    (task.title ?? '').toLowerCase().includes(q) ||
    (task.description ?? '').toLowerCase().includes(q) ||
    (task.specId ?? '').toLowerCase().includes(q)
  );
}

/** Filters every column by the search query; returns `columns` itself when the query is empty. */
export function filterColumnsBySearch<T extends Record<string, Task[]>>(columns: T, query: string): T {
  if (!query.trim()) return columns;
  const result: Record<string, Task[]> = {};
  for (const key of Object.keys(columns)) {
    result[key] = columns[key].filter((task) => taskMatchesSearch(task, query));
  }
  return result as T;
}
