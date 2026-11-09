/**
 * zeenha fork: spotting parallel tasks that plan to change the same files.
 *
 * Two tasks that run at once and edit the same file produce merge conflicts
 * later. Each task's planned files are the union of its subtasks' file lists.
 * A task with no known planned files is "unknown" and never overlaps with
 * anything, so the warning only fires on real evidence.
 *
 * Pure functions only, so the renderer and the main process share one rule.
 */
import type { Task, TaskStatus } from '../types';

export interface TaskFileOverlap {
  taskId: string;
  title: string;
  /** Planned files both tasks share, sorted alphabetically. */
  files: string[];
}

/** Statuses in which a task is considered to have finished its coding work. */
export const FINISHED_TASK_STATUSES: readonly TaskStatus[] = ['human_review', 'done', 'pr_created'];

const OVERLAP_CANDIDATE_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'backlog',
  'queue',
  'in_progress',
  'ai_review',
  'human_review',
]);

export function normalizePlannedPath(path: string): string {
  let result = path.trim().replace(/\\/g, '/');
  while (result.startsWith('./')) result = result.slice(2).trimStart();
  return result;
}

/**
 * Deduped, normalized union of every subtask's files. Null ("unknown") when
 * the task has no subtasks or no file in any of them.
 */
export function getPlannedFiles(task: Pick<Task, 'subtasks'>): string[] | null {
  if (!task.subtasks || task.subtasks.length === 0) return null;
  const files = new Set<string>();
  for (const subtask of task.subtasks) {
    for (const file of subtask.files ?? []) {
      if (typeof file !== 'string') continue;
      const normalized = normalizePlannedPath(file);
      if (normalized) files.add(normalized);
    }
  }
  return files.size > 0 ? [...files] : null;
}

export function isOverlapCandidate(task: Pick<Task, 'status' | 'metadata'>): boolean {
  if (task.metadata?.archivedAt) return false;
  return OVERLAP_CANDIDATE_STATUSES.has(task.status);
}

/**
 * For each task with at least one overlap, the other tasks it shares planned
 * files with. Tasks without overlaps have no entry.
 */
export function findFileOverlaps(tasks: readonly Task[]): Map<string, TaskFileOverlap[]> {
  const candidates: Array<{ task: Task; files: string[]; fileSet: Set<string> }> = [];
  for (const task of tasks) {
    if (!isOverlapCandidate(task)) continue;
    const files = getPlannedFiles(task);
    if (!files) continue;
    candidates.push({ task, files, fileSet: new Set(files) });
  }

  const result = new Map<string, TaskFileOverlap[]>();
  for (const a of candidates) {
    const overlaps: TaskFileOverlap[] = [];
    for (const b of candidates) {
      if (a.task.id === b.task.id || a.task.projectId !== b.task.projectId) continue;
      const shared = b.files.filter((f) => a.fileSet.has(f)).sort();
      if (shared.length > 0) {
        overlaps.push({ taskId: b.task.id, title: b.task.title, files: shared });
      }
    }
    if (overlaps.length > 0) {
      overlaps.sort((x, y) => x.title.localeCompare(y.title) || x.taskId.localeCompare(y.taskId));
      result.set(a.task.id, overlaps);
    }
  }
  return result;
}

/**
 * True while the task waits for the task named in metadata.holdUntilTaskId.
 * A blocker that is missing, archived or finished no longer holds the task.
 */
export function isHoldActive(task: Pick<Task, 'metadata'>, tasks: readonly Task[]): boolean {
  const blockerId = task.metadata?.holdUntilTaskId;
  if (!blockerId) return false;
  const blocker = tasks.find((t) => t.id === blockerId);
  if (!blocker || blocker.metadata?.archivedAt) return false;
  return !FINISHED_TASK_STATUSES.includes(blocker.status);
}
