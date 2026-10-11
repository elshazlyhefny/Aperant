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
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { KeptReason, MergedCleanupOutcome, Project, Task } from '../shared/types';
import { cleansUpMergedWorktrees } from '../shared/utils/worktree-cleanup-policy';
import { getToolPath } from './cli-tool-manager';
import { getAugmentedEnv } from './env-utils';
import { getIsolatedGitEnv } from './utils/git-isolation';
import { getTaskWorktreeDir, isPathWithinBase } from './worktree-paths';

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
  /** Is this folder a live git worktree of its own (not a half-deleted leftover)? */
  isRealWorktree(worktreePath: string): Promise<boolean>;
  hasUncommittedChanges(worktreePath: string): Promise<boolean>;
  headCommit(worktreePath: string): Promise<string | null>;
  /** Tip of a local branch in the project repository, or null if it does not exist. */
  branchTip(projectPath: string, branch: string): Promise<string | null>;
  /** Is `commit` the PR's head or an ancestor of it? Null when it cannot be told. */
  isInPullRequest(projectPath: string, commit: string, prUrl: string, prHead: string): Promise<boolean | null>;
  /** Make every file in the folder deletable BEFORE anything is deleted; false (with why) if that is not possible. */
  ensureDeletable(worktreePath: string, projectPath: string): Promise<{ ok: boolean; detail?: string }>;
  remove(args: { worktreePath: string; projectPath: string; specId: string }): Promise<{ success: boolean; warnings: string[] }>;
  /** Delete a local task branch whose worktree folder is already gone. */
  deleteBranch(projectPath: string, branch: string): Promise<{ success: boolean; detail?: string }>;
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
      const branchName = `auto-claude/${task.specId}`;

      const base = { projectId: project.id, taskId: task.id, specId: task.specId, prUrl };
      const keep = (reason: KeptReason, detail?: string) =>
        outcomes.push({ ...base, status: 'kept', reason, ...(detail ? { detail } : {}) });

      // The folder is already gone (removed earlier, or by hand) but the local
      // branch is left: same PR and "nothing unmerged" checks, then the branch.
      if (!worktreePath) {
        const orphanTip = await deps.branchTip(project.path, branchName);
        if (!orphanTip) continue;
        try {
          const pr = await deps.prState(prUrl, project.path);
          if (!pr || pr.state !== 'MERGED') continue; // nothing to report for a branch alone
          if (deps.isRunning(task.id)) continue;
          const merged = await deps.isInPullRequest(project.path, orphanTip, prUrl, pr.headRefOid);
          if (merged !== true) {
            if (merged === false) keep('commits_after_merge');
            continue;
          }
          const deleted = await deps.deleteBranch(project.path, branchName);
          if (deleted.success) {
            removedAny = true;
            outcomes.push({ ...base, status: 'removed' });
          } else {
            keep('cleanup_failed', deleted.detail);
          }
        } catch (error) {
          keep('cleanup_failed', error instanceof Error ? error.message : String(error));
        }
        continue;
      }

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

        if (deps.isRunning(task.id)) {
          keep('running');
          continue;
        }

        // A folder whose .git link is gone is a leftover of an earlier, partly
        // failed removal. git inside it would answer for the PARENT repository,
        // so its checks run against the task's branch instead.
        const real = await deps.isRealWorktree(worktreePath);
        let tip: string | null;
        if (real) {
          if (await deps.hasUncommittedChanges(worktreePath)) {
            keep('uncommitted_changes');
            continue;
          }
          tip = await deps.headCommit(worktreePath);
          if (!tip) {
            keep('head_unreadable');
            continue;
          }
        } else {
          tip = await deps.branchTip(project.path, `auto-claude/${task.specId}`);
        }

        // Nothing unmerged: the tip is the PR's head or behind it (commits can
        // be added to a PR on GitHub, by a person or the merge queue).
        if (tip) {
          const merged = await deps.isInPullRequest(project.path, tip, prUrl, pr.headRefOid);
          if (merged === null) {
            keep('pr_unreadable');
            continue;
          }
          if (!merged) {
            keep('commits_after_merge');
            continue;
          }
        }

        // Before ANY deletion: files owned by another user (root, from Docker
        // runs) would stop the delete half-way and leave a broken folder.
        const deletable = await deps.ensureDeletable(worktreePath, project.path);
        if (!deletable.ok) {
          keep('foreign_owned_files', deletable.detail);
          continue;
        }

        // Re-checked right before removal: an agent may have started meanwhile.
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

/** True only when git's own top level for the folder IS the folder (a live worktree). */
export async function worktreeIsReal(worktreePath: string): Promise<boolean> {
  try {
    const top = (await gitInWorktree(worktreePath, ['rev-parse', '--show-toplevel'])).trim();
    const [a, b] = await Promise.all([realpath(top), realpath(worktreePath)]);
    return a === b;
  } catch {
    return false;
  }
}

export async function branchTipInRepo(projectPath: string, branch: string): Promise<string | null> {
  if (!/^auto-claude\/[A-Za-z0-9._-]+$/.test(branch)) return null;
  try {
    const out = (await gitInWorktree(projectPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).trim();
    return /^[0-9a-f]{40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * Is `commit` the PR's head or an ancestor of it? The PR head is fetched from
 * GitHub's own pull ref (works for squash merges and for commits added on
 * GitHub) into a private ref, never FETCH_HEAD, which other git runs share.
 */
export async function commitIsInPullRequest(
  projectPath: string,
  commit: string,
  prUrl: string,
  prHead: string,
): Promise<boolean | null> {
  if (commit === prHead) return true;
  const number = /\/pull\/(\d+)$/.exec(prUrl)?.[1];
  if (!number || !/^[0-9a-f]{40}$/.test(commit) || !/^[0-9a-f]{40}$/.test(prHead)) return null;
  const ref = `refs/aperant/merged-cleanup/pr-${number}`;
  try {
    await run(
      getToolPath('git'),
      ['fetch', '--quiet', '--no-tags', 'origin', `+refs/pull/${number}/head:${ref}`],
      projectPath,
      { ...getIsolatedGitEnv(), GIT_TERMINAL_PROMPT: '0' },
      GH_TIMEOUT_MS,
    );
  } catch {
    return null;
  }
  try {
    await gitInWorktree(projectPath, ['merge-base', '--is-ancestor', commit, ref]);
    return true;
  } catch (error) {
    // exit 1 = not an ancestor; anything else = could not tell
    return (error as { code?: number }).code === 1 ? false : null;
  }
}

/** Delete a local task branch. Only `auto-claude/*`; anything else is refused. */
export async function deleteTaskBranch(projectPath: string, branch: string): Promise<{ success: boolean; detail?: string }> {
  if (!/^auto-claude\/[A-Za-z0-9._-]+$/.test(branch)) return { success: false, detail: `refusing to delete "${branch}"` };
  try {
    await gitInWorktree(projectPath, ['branch', '-D', branch]);
    return { success: true };
  } catch (error) {
    return { success: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** First path under `dir` not owned by `uid` (symlinks are not followed), or null. */
async function firstForeignOwned(dir: string, uid: number): Promise<string | null> {
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    const info = await lstat(current);
    if (info.uid !== uid) return current;
    if (!info.isDirectory()) continue;
    for (const name of await readdir(current)) stack.push(path.join(current, name));
  }
  return null;
}

/**
 * Before anything is deleted, make sure everything CAN be: agents run Docker as
 * root through the worktree's bind mount, which leaves root-owned vendor/,
 * .nuxt/ and cache trees that a plain delete cannot remove. Those are handed
 * back with a throwaway container (the repository runbook's own repair), then
 * checked again. Never deletes anything itself.
 */
export async function ensureWorktreeDeletable(
  worktreePath: string,
  projectPath: string,
): Promise<{ ok: boolean; detail?: string }> {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) return { ok: true }; // Windows: no ownership problem to fix
  if (!isPathWithinBase(path.resolve(worktreePath), getTaskWorktreeDir(projectPath))) {
    return { ok: false, detail: 'outside the task worktree folder' };
  }

  let foreign: string | null;
  try {
    foreign = await firstForeignOwned(worktreePath, uid);
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
  if (!foreign) return { ok: true };

  try {
    await run(
      'docker',
      ['run', '--rm', '--network', 'none', '-v', `${path.resolve(worktreePath)}:/w`, 'alpine:3.20', 'chown', '-R', `${uid}:${gid}`, '/w'],
      projectPath,
      { ...getAugmentedEnv() },
      120_000,
    );
  } catch {
    return { ok: false, detail: `${path.relative(worktreePath, foreign)} is owned by another user and Docker could not hand it back` };
  }

  try {
    foreign = await firstForeignOwned(worktreePath, uid);
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
  return foreign ? { ok: false, detail: `${path.relative(worktreePath, foreign)} is still owned by another user` } : { ok: true };
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
