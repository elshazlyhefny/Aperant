/**
 * zeenha fork: remove a task's worktree once its pull request has MERGED.
 *
 * Nothing used to clean up after a merge: a worktree went away only when its
 * task was deleted, so merged ones piled up (50 on one laptop, most of them
 * landed). This removes a worktree and its local `auto-claude/<specId>` branch
 * only when every check below holds, and otherwise keeps it and says why:
 *
 *   1. the task has a recorded PR URL and GitHub reports it MERGED
 *      (a closed-but-unmerged PR is not merged)
 *   2. no agent is running on the task
 *   3. the worktree has no uncommitted changes (Aperant's own `.auto-claude`
 *      files excepted, the same exclusion Create PR uses)
 *   4. the worktree's HEAD is exactly the PR's head commit, so nothing was
 *      committed after the merge
 *
 * Check 3 carries the most weight: `cleanupWorktree` deletes the directory by
 * hand (a plain `git worktree remove` fails on Windows), so it would take
 * uncommitted work with it.
 *
 * The spec folder, task history and logs are kept; the remote branch is left
 * to GitHub's "delete branch on merge". A project can turn this off with the
 * `autoCleanupMergedWorktrees` setting (default on).
 */

import { execFile } from 'node:child_process';
import type { KeptReason, MergedCleanupOutcome, Project, Task } from '../shared/types';
import { cleansUpMergedWorktrees } from '../shared/utils/worktree-cleanup-policy';
import { getToolPath } from './cli-tool-manager';
import { getAugmentedEnv } from './env-utils';
import { getIsolatedGitEnv } from './utils/git-isolation';

export type { KeptReason, MergedCleanupOutcome };

export interface PullRequestState {
  state: string; // OPEN | CLOSED | MERGED
  headRefOid: string;
}

export interface MergedCleanupDeps {
  listProjects(): Project[];
  listTasks(projectId: string): Task[];
  findWorktree(projectPath: string, specId: string): string | null;
  isRunning(taskId: string): boolean;
  prState(prUrl: string, projectPath: string): Promise<PullRequestState | null>;
  hasUncommittedChanges(worktreePath: string): Promise<boolean>;
  headCommit(worktreePath: string): Promise<string | null>;
  remove(args: { worktreePath: string; projectPath: string; specId: string }): Promise<{ success: boolean; warnings: string[] }>;
  invalidate(projectId: string): void;
}

/**
 * Decide and act for every task with a recorded PR and a worktree, in one
 * project or all of them. Never throws; every task gets an outcome.
 */
export async function cleanupMergedWorktrees(
  deps: MergedCleanupDeps,
  options: { projectId?: string } = {},
): Promise<MergedCleanupOutcome[]> {
  const outcomes: MergedCleanupOutcome[] = [];
  const projects = deps
    .listProjects()
    .filter((p) => !options.projectId || p.id === options.projectId)
    .filter((p) => cleansUpMergedWorktrees(p.settings));

  for (const project of projects) {
    let removedAny = false;

    for (const task of deps.listTasks(project.id)) {
      const prUrl = task.metadata?.prUrl;
      if (!prUrl) continue;
      const worktreePath = deps.findWorktree(project.path, task.specId);
      if (!worktreePath) continue;

      const base = { projectId: project.id, taskId: task.id, specId: task.specId, prUrl };
      const keep = (reason: KeptReason, detail?: string) =>
        outcomes.push({ ...base, status: 'kept', reason, ...(detail ? { detail } : {}) });

      try {
        const pr = await deps.prState(prUrl, project.path);
        if (!pr) {
          keep('pr_unreadable');
          continue;
        }
        if (pr.state !== 'MERGED') {
          outcomes.push({ ...base, status: 'not_merged' });
          continue;
        }

        // Re-checked right before removal: an agent may have started meanwhile.
        if (deps.isRunning(task.id)) {
          keep('running');
          continue;
        }
        if (await deps.hasUncommittedChanges(worktreePath)) {
          keep('uncommitted_changes');
          continue;
        }
        const head = await deps.headCommit(worktreePath);
        if (!head) {
          keep('head_unreadable');
          continue;
        }
        if (head !== pr.headRefOid) {
          keep('commits_after_merge');
          continue;
        }
        if (deps.isRunning(task.id)) {
          keep('running');
          continue;
        }

        const result = await deps.remove({ worktreePath, projectPath: project.path, specId: task.specId });
        if (!result.success) {
          keep('cleanup_failed', result.warnings.join('; '));
          continue;
        }
        removedAny = true;
        outcomes.push({ ...base, status: 'removed' });
      } catch (error) {
        keep('cleanup_failed', error instanceof Error ? error.message : String(error));
      }
    }

    if (removedAny) deps.invalidate(project.id);
  }

  return outcomes;
}

// =============================================================================
// Real dependencies
// =============================================================================

const GH_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 15_000;

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, env, timeout, maxBuffer: 1024 * 1024, encoding: 'utf-8' }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });
}

export async function readPullRequestState(prUrl: string, projectPath: string): Promise<PullRequestState | null> {
  if (!/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/.test(prUrl)) return null;
  try {
    const out = await run(
      getToolPath('gh'),
      ['pr', 'view', prUrl, '--json', 'state,headRefOid'],
      projectPath,
      { ...getAugmentedEnv(), GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
      GH_TIMEOUT_MS,
    );
    const parsed = JSON.parse(out) as Partial<PullRequestState>;
    if (typeof parsed.state !== 'string' || typeof parsed.headRefOid !== 'string') return null;
    return { state: parsed.state, headRefOid: parsed.headRefOid };
  } catch {
    return null;
  }
}

async function gitInWorktree(worktreePath: string, args: string[]): Promise<string> {
  return run(getToolPath('git'), args, worktreePath, { ...getIsolatedGitEnv(), GIT_TERMINAL_PROMPT: '0' }, GIT_TIMEOUT_MS);
}

/** Uncommitted work, Aperant's own `.auto-claude` files excepted. Errors count as dirty. */
export async function worktreeHasUncommittedChanges(worktreePath: string): Promise<boolean> {
  try {
    const out = await gitInWorktree(worktreePath, ['status', '--porcelain', '--', '.', ':(exclude).auto-claude']);
    return out.trim().length > 0;
  } catch {
    return true;
  }
}

export async function worktreeHeadCommit(worktreePath: string): Promise<string | null> {
  try {
    const out = (await gitInWorktree(worktreePath, ['rev-parse', 'HEAD'])).trim();
    return /^[0-9a-f]{40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

// One run at a time: the timer, opening the Worktrees page and the button can overlap.
let inFlight: Promise<MergedCleanupOutcome[]> | null = null;

export function runMergedWorktreeCleanup(
  deps: MergedCleanupDeps,
  options: { projectId?: string } = {},
): Promise<MergedCleanupOutcome[]> {
  if (inFlight) return inFlight;
  inFlight = cleanupMergedWorktrees(deps, options).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export const MERGED_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
export const MERGED_CLEANUP_FIRST_RUN_MS = 60 * 1000;
