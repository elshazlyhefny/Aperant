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
import type { Task, TaskPriority, TaskStatus } from '../../shared/types';
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

/**
 * Whether a task matches the board search query (case-insensitive). Matches a
 * substring of title, description or spec ID, or EXACTLY an external issue key
 * (Jira 'PROJ-123', Linear 'ABC-12', GitHub/GitLab '#87'), so 'PROJ-123' does
 * not match 'PROJ-1234' and '#87' does not match '#871'.
 */
export function taskMatchesSearch(
  task: Pick<Task, 'title' | 'description' | 'specId' | 'metadata'>,
  query: string
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (
    (task.title ?? '').toLowerCase().includes(q) ||
    (task.description ?? '').toLowerCase().includes(q) ||
    (task.specId ?? '').toLowerCase().includes(q)
  ) {
    return true;
  }
  const meta = task.metadata;
  if (!meta) return false;
  if (meta.jiraIssueKey && meta.jiraIssueKey.toLowerCase() === q) return true;
  if (meta.linearIdentifier && meta.linearIdentifier.toLowerCase() === q) return true;
  if (meta.githubIssueNumber && `#${meta.githubIssueNumber}` === q) return true;
  if (meta.githubIssueNumbers?.some((n) => `#${n}` === q)) return true;
  if (meta.gitlabIssueIid && `#${meta.gitlabIssueIid}` === q) return true;
  return false;
}

/** Task sources selectable in the board's source filter ('imported' has no option). */
export const TASK_SOURCE_FILTERS = [
  'github',
  'gitlab',
  'jira',
  'linear',
  'ideation',
  'roadmap',
  'schedule',
  'insights',
  'manual',
] as const satisfies readonly NonNullable<NonNullable<Task['metadata']>['sourceType']>[];
export type TaskSourceFilter = (typeof TASK_SOURCE_FILTERS)[number];

export const TASK_PRIORITY_FILTERS = ['low', 'medium', 'high', 'urgent'] as const satisfies readonly TaskPriority[];
export type TaskPriorityFilter = (typeof TASK_PRIORITY_FILTERS)[number];

/** A task's source; a missing sourceType counts as 'manual'. */
export function getTaskSource(task: Pick<Task, 'metadata'>): string {
  return task.metadata?.sourceType ?? 'manual';
}

/**
 * zeenha fork: filters every column by source and priority facets. Within a
 * facet selections are OR-ed; the two facets are AND-ed; an empty facet does
 * not filter. Tasks without a priority are excluded while a priority is
 * selected. Returns `columns` itself when both lists are empty. Order and keys
 * (including empty columns) are preserved.
 */
export function filterColumnsByFacets<T extends Record<string, Task[]>>(
  columns: T,
  facets: { sources: readonly string[]; priorities: readonly string[] }
): T {
  const { sources, priorities } = facets;
  if (sources.length === 0 && priorities.length === 0) return columns;
  const result: Record<string, Task[]> = {};
  for (const key of Object.keys(columns)) {
    result[key] = columns[key].filter((task) => {
      if (sources.length > 0 && !sources.includes(getTaskSource(task))) return false;
      if (priorities.length > 0) {
        const priority = task.metadata?.priority;
        if (!priority || !priorities.includes(priority)) return false;
      }
      return true;
    });
  }
  return result as T;
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
