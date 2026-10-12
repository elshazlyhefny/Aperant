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
import type { TaskStatus } from '../../shared/types';

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
