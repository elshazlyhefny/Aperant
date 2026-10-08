import type { ProjectSettings } from '../types/project';

/**
 * zeenha fork: does this project land work only through pull requests?
 *
 * On by default (a missing setting means yes). When on, the app refuses both
 * ways of putting work on the base branch without the project's CI and merge
 * queue: merging a task worktree locally (TASK_WORKTREE_MERGE) and merging a
 * GitHub PR from inside the app (GITHUB_PR_MERGE). Work lands by "Create PR";
 * the repository's merge queue decides when it reaches main.
 *
 * Enforced in the main-process handlers, not only by hiding buttons, so a
 * renderer bug or a stale window cannot bypass it.
 */
export function landsThroughPullRequestsOnly(settings?: Partial<ProjectSettings> | null): boolean {
  return settings?.prOnlyLanding !== false;
}

export const PR_ONLY_LANDING_MESSAGE =
  'This project lands work through pull requests only. Use "Create PR"; the merge queue lands it. ' +
  'Turn off "Land through pull requests only" in the project settings to merge here.';
