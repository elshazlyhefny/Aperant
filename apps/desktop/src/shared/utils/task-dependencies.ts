/**
 * zeenha fork: task-to-task dependencies. A task listed in another task's
 * `metadata.taskDependencies` must be finished before the dependent task may
 * leave the queue.
 *
 * "Finished" means status `done` and nothing else. A `pr_created` task has an
 * open PR but its code is not on the base branch until the PR merges and the
 * user marks the task Done; Human Review "completed" is likewise not finished.
 *
 * This is the ONE definition of the rules; the main process (queue gating, IPC
 * validation) and the renderer (picker, badges) both use it.
 */
import type { Task } from '../types';
import { isFailedRun } from './task-failure';

export type DependencyBlockerReason = 'not_finished' | 'pr_not_merged' | 'failed' | 'missing' | 'archived';

export interface DependencyBlocker {
  taskId: string;
  title: string;
  reason: DependencyBlockerReason;
}

export interface DependencyEvaluation {
  state: 'ready' | 'waiting' | 'blocked';
  blockers: DependencyBlocker[];
}

export type DependencyValidation =
  | { ok: true; deps: string[] }
  | { ok: false; code: 'self' | 'unknown' | 'cycle'; ids: string[] };

type TaskLike = Pick<Task, 'id' | 'specId' | 'title' | 'status' | 'reviewReason' | 'metadata' | 'executionProgress'>;

/**
 * zeenha fork: keep in sync with guides/task-dependencies.md ("When is a
 * dependency finished?"). Change the rule here and the guide together.
 * True ONLY when the task is Done.
 */
export function isDependencyFinished(task: Pick<Task, 'status'>): boolean {
  return task.status === 'done';
}

function findTask(ref: string, allTasks: ReadonlyArray<TaskLike>): TaskLike | undefined {
  return allTasks.find((t) => t.id === ref) ?? allTasks.find((t) => t.specId === ref);
}

function depsOf(task: TaskLike | undefined): string[] {
  return task?.metadata?.taskDependencies ?? [];
}

export function evaluateTaskDependencies(
  task: Pick<Task, 'metadata'>,
  allTasks: ReadonlyArray<TaskLike>
): DependencyEvaluation {
  const refs = task.metadata?.taskDependencies ?? [];
  const blockers: DependencyBlocker[] = [];

  for (const ref of refs) {
    const dep = findTask(ref, allTasks);
    if (!dep) {
      blockers.push({ taskId: ref, title: ref, reason: 'missing' });
      continue;
    }
    if (isDependencyFinished(dep)) continue;

    let reason: DependencyBlockerReason;
    if (dep.metadata?.archivedAt) {
      reason = 'archived';
    } else if (
      isFailedRun({
        status: dep.status,
        reviewReason: dep.reviewReason,
        executionPhase: dep.executionProgress?.phase,
      })
    ) {
      reason = 'failed';
    } else if (dep.status === 'pr_created') {
      reason = 'pr_not_merged';
    } else {
      reason = 'not_finished';
    }
    blockers.push({ taskId: dep.id, title: dep.title, reason });
  }

  if (blockers.length === 0) return { state: 'ready', blockers };
  const blocked = blockers.some((b) => b.reason === 'failed' || b.reason === 'missing' || b.reason === 'archived');
  return { state: blocked ? 'blocked' : 'waiting', blockers };
}

/**
 * The cycle path (task ids, first id repeated at the end) that giving `taskId`
 * the dependencies `proposedDeps` would create, or null. A self-dependency is
 * a cycle.
 */
export function findDependencyCycle(
  taskId: string,
  proposedDeps: ReadonlyArray<string>,
  allTasks: ReadonlyArray<TaskLike>
): string[] | null {
  const self = findTask(taskId, allTasks);
  const selfIds = new Set<string>([taskId]);
  if (self) {
    selfIds.add(self.id);
    selfIds.add(self.specId);
  }
  const canonical = self?.id ?? taskId;

  const edges = (ref: string): string[] => {
    if (selfIds.has(ref)) return [...proposedDeps];
    return depsOf(findTask(ref, allTasks));
  };
  const keyOf = (ref: string): string => (selfIds.has(ref) ? canonical : (findTask(ref, allTasks)?.id ?? ref));

  const done = new Set<string>();
  const path: string[] = [];
  const onPath = new Set<string>();

  const visit = (ref: string): string[] | null => {
    const key = keyOf(ref);
    if (onPath.has(key)) return [...path.slice(path.indexOf(key)), key];
    if (done.has(key)) return null;
    onPath.add(key);
    path.push(key);
    for (const next of edges(ref)) {
      const found = visit(next);
      if (found) return found;
    }
    path.pop();
    onPath.delete(key);
    done.add(key);
    return null;
  };

  return visit(taskId);
}

export function validateTaskDependencies(
  taskId: string,
  proposedDeps: ReadonlyArray<string>,
  allTasks: ReadonlyArray<TaskLike>
): DependencyValidation {
  const deps = [...new Set(proposedDeps)];
  const self = findTask(taskId, allTasks);
  const isSelf = (ref: string) => ref === taskId || (!!self && (ref === self.id || ref === self.specId));

  const selfIds = deps.filter(isSelf);
  if (selfIds.length > 0) return { ok: false, code: 'self', ids: selfIds };

  const unknown = deps.filter((ref) => !findTask(ref, allTasks));
  if (unknown.length > 0) return { ok: false, code: 'unknown', ids: unknown };

  const cycle = findDependencyCycle(taskId, deps, allTasks);
  if (cycle) return { ok: false, code: 'cycle', ids: cycle };

  return { ok: true, deps };
}

/**
 * zeenha fork: queue candidate selection. Returns the oldest queued task whose
 * dependencies are all finished. Held tasks (waiting/blocked) and tasks in
 * `excludeIds` (promotion already failed this pass) are skipped; being held is
 * not a promotion failure.
 */
export function pickNextEligibleQueuedTask<T extends TaskLike & { createdAt: Date | string }>(
  allTasks: ReadonlyArray<T>,
  excludeIds: ReadonlySet<string> = new Set()
): T | undefined {
  const eligible = allTasks.filter(
    (t) =>
      t.status === 'queue' &&
      !t.metadata?.archivedAt &&
      !excludeIds.has(t.id) &&
      evaluateTaskDependencies(t, allTasks).state === 'ready'
  );
  return eligible.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0];
}
