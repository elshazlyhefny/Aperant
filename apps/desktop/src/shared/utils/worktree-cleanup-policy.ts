import type { ProjectSettings } from '../types/project';

/**
 * zeenha fork: does this project remove a task's worktree once its PR has
 * merged? On by default (a missing setting means yes). The safety checks live
 * in main/worktree-auto-cleanup.ts.
 */
export function cleansUpMergedWorktrees(settings?: Partial<ProjectSettings> | null): boolean {
  return settings?.autoCleanupMergedWorktrees !== false;
}
