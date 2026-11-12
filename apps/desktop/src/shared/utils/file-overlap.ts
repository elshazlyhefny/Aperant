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
 * Deduped union of a plan subtask's files_to_modify and files_to_create.
 * Plans are written by an LLM, so anything that is not a string array is ignored.
 */
export function extractPlannedFiles(subtask: {
  files_to_modify?: unknown;
  files_to_create?: unknown;
}): string[] {
  const files = new Set<string>();
  for (const list of [subtask.files_to_modify, subtask.files_to_create]) {
    if (!Array.isArray(list)) continue;
    for (const file of list) {
      if (typeof file === 'string' && file.trim()) files.add(file);
    }
  }
  return [...files];
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

/**
 * A string that changes only when an input of findFileOverlaps or the hold
 * logic changes (id, project, status, archived flag, title, hold blocker and
 * planned files). Progress, logs and timestamps are left out on purpose.
 * Planned files are only read for overlap candidates.
 */
export function getOverlapInputKey(tasks: readonly Task[]): string {
  const parts: string[] = [];
  for (const task of tasks) {
    let part = [
      task.id,
      task.projectId,
      task.status,
      task.metadata?.archivedAt ? '1' : '0',
      task.title,
      task.metadata?.holdUntilTaskId ?? '',
    ].join('\u0001');
    if (isOverlapCandidate(task) && task.subtasks) {
      for (const subtask of task.subtasks) {
        part += `\u0002${(subtask.files ?? []).join('\u0000')}`;
      }
    }
    parts.push(part);
  }
  return parts.join('\u0003');
}

function overlapListsAreEqual(a: readonly TaskFileOverlap[], b: readonly TaskFileOverlap[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.taskId !== y.taskId || x.title !== y.title || x.files.length !== y.files.length) return false;
    for (let j = 0; j < x.files.length; j++) {
      if (x.files[j] !== y.files[j]) return false;
    }
  }
  return true;
}

/**
 * Keeps the previous arrays (and the previous Map when nothing changed) so
 * consumers that compare by reference do not see a change.
 */
export function reuseFileOverlaps(
  prev: Map<string, TaskFileOverlap[]> | undefined,
  next: Map<string, TaskFileOverlap[]>
): Map<string, TaskFileOverlap[]> {
  if (!prev) return next;
  const merged = new Map<string, TaskFileOverlap[]>();
  let allReused = prev.size === next.size;
  for (const [id, list] of next) {
    const old = prev.get(id);
    if (old && overlapListsAreEqual(old, list)) {
      merged.set(id, old);
    } else {
      merged.set(id, list);
      allReused = false;
    }
  }
  return allReused ? prev : merged;
}

/**
 * Held task id -> title of its active blocker. Same rule as isHoldActive, but
 * with one id lookup table instead of a scan per task.
 */
export function buildHoldBlockerTitles(tasks: readonly Task[]): Map<string, string> {
  const byId = new Map<string, Task>();
  for (const task of tasks) {
    if (!byId.has(task.id)) byId.set(task.id, task);
  }
  const result = new Map<string, string>();
  for (const task of tasks) {
    const blockerId = task.metadata?.holdUntilTaskId;
    if (!blockerId) continue;
    const blocker = byId.get(blockerId);
    if (!blocker || blocker.metadata?.archivedAt) continue;
    if (FINISHED_TASK_STATUSES.includes(blocker.status)) continue;
    result.set(task.id, blocker.title);
  }
  return result;
}

export function reuseHoldBlockerTitles(
  prev: Map<string, string> | undefined,
  next: Map<string, string>
): Map<string, string> {
  if (!prev) return next;
  if (prev.size !== next.size) return next;
  for (const [id, title] of next) {
    if (prev.get(id) !== title) return next;
  }
  return prev;
}

/** True when the overlap and hold-title entries of the given tasks are unchanged. */
export function columnOverlapEntriesAreEqual(
  tasks: readonly Pick<Task, 'id'>[],
  prevOverlaps: Map<string, TaskFileOverlap[]> | undefined,
  nextOverlaps: Map<string, TaskFileOverlap[]> | undefined,
  prevTitles: Map<string, string> | undefined,
  nextTitles: Map<string, string> | undefined
): boolean {
  for (const { id } of tasks) {
    if (prevOverlaps?.get(id) !== nextOverlaps?.get(id)) return false;
    if (prevTitles?.get(id) !== nextTitles?.get(id)) return false;
  }
  return true;
}
