/**
 * zeenha fork: save-time validation of `metadata.taskDependencies`.
 *
 * Kept free of Electron imports so it can be unit tested directly. The error
 * strings are stable and machine-readable (no i18n) so the renderer can
 * translate them:
 *   DEPENDENCY_SELF:<id>,<id>
 *   DEPENDENCY_UNKNOWN:<id>,<id>
 *   DEPENDENCY_CYCLE:<id>-><id>-><id>
 */
import type { Task } from '../../../shared/types';
import { validateTaskDependencies } from '../../../shared/utils/task-dependencies';

/** Placeholder id for a task that does not exist yet (TASK_CREATE). */
export const NEW_TASK_PLACEHOLDER_ID = '__new_task__';

export type DependencySaveValidation =
  | { ok: true; deps: string[] }
  | { ok: false; error: string };

export function validateDependenciesForSave(
  taskId: string,
  proposedDeps: ReadonlyArray<string>,
  allTasks: ReadonlyArray<Task>
): DependencySaveValidation {
  const result = validateTaskDependencies(taskId, proposedDeps, allTasks);
  if (result.ok) return { ok: true, deps: result.deps };
  switch (result.code) {
    case 'self':
      return { ok: false, error: `DEPENDENCY_SELF:${result.ids.join(',')}` };
    case 'unknown':
      return { ok: false, error: `DEPENDENCY_UNKNOWN:${result.ids.join(',')}` };
    case 'cycle':
      return { ok: false, error: `DEPENDENCY_CYCLE:${result.ids.join('->')}` };
  }
}
