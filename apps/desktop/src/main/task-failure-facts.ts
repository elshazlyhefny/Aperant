/**
 * zeenha fork: the main-process facts behind failedBeforeAnyWork()
 * (shared/utils/task-failure): every known subtask status, whether the task's
 * worktree holds code changes, and the recorded failure reason.
 *
 * Used by task-state-manager (the machine enters `error`) and project-store
 * (tasks read from disk), so both decide Failed vs Human Review the same way.
 */
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { AUTO_BUILD_PATHS } from '../shared/constants';
import type { TaskLogs } from '../shared/types';
import { reasonFromPhaseEndMessage } from '../shared/utils/task-failure';
import { getToolPath } from './cli-tool-manager';
import { getIsolatedGitEnv } from './utils/git-isolation';
import { safeParseJson } from './utils/json-repair';
import { findTaskWorktree } from './worktree-paths';

/** Runs git in a directory and returns stdout; throws on failure. */
export type GitRunner = (args: string[], cwd: string) => string;

const defaultGit: GitRunner = (args, cwd) =>
  execFileSync(getToolPath('git'), args, {
    cwd,
    encoding: 'utf-8',
    env: getIsolatedGitEnv(),
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });

/**
 * True when the worktree holds work: uncommitted changes outside
 * `.auto-claude`, or commits on its branch that no other local branch or
 * remote has (the task's own commits, whatever the base branch). Null when git
 * fails, so the caller treats the task as possibly having work.
 */
export function worktreeHasCodeChanges(worktreePath: string, git: GitRunner = defaultGit): boolean | null {
  try {
    const status = git(['status', '--porcelain', '--', '.', ':(exclude).auto-claude'], worktreePath);
    if (status.trim() !== '') return true;

    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath).trim();
    const onBranch = branch !== '' && branch !== 'HEAD';
    const args = ['rev-list', '--count', 'HEAD', '--not'];
    if (onBranch) args.push(`--exclude=${branch}`);
    args.push('--branches');
    if (onBranch) args.push(`--exclude=*/${branch}`);
    args.push('--remotes');
    const count = Number.parseInt(git(args, worktreePath).trim(), 10);
    if (!Number.isInteger(count) || count < 0) return null;
    return count > 0;
  } catch {
    return null;
  }
}

const CHANGES_TTL_MS = 10_000;
const changesCache = new Map<string, { value: boolean | null; at: number }>();

/** Test hook. */
export function clearCodeChangesCache(): void {
  changesCache.clear();
}

/**
 * Whether the task's workspace holds code changes. No worktree means nothing
 * was changed in isolation (false), unless the task was set to run without a
 * worktree: then its changes would be in the project itself and cannot be told
 * apart (null). Cached briefly because the task list is re-read often;
 * `fresh` skips the cache (the moment a run fails).
 */
export function taskHasCodeChanges(
  projectPath: string,
  specId: string,
  options: { useWorktree?: boolean; git?: GitRunner; fresh?: boolean } = {}
): boolean | null {
  if (options.useWorktree === false) return null;
  const worktreePath = findTaskWorktree(projectPath, specId);
  if (!worktreePath) return false;

  const cached = changesCache.get(worktreePath);
  if (!options.fresh && cached && Date.now() - cached.at < CHANGES_TTL_MS) return cached.value;
  const value = worktreeHasCodeChanges(worktreePath, options.git);
  changesCache.set(worktreePath, { value, at: Date.now() });
  return value;
}

/** The spec directories of a task: the main project's, then the worktree's when it exists. */
export function taskSpecDirs(projectPath: string, specsBaseDir: string, specId: string): string[] {
  const dirs = [path.join(projectPath, specsBaseDir, specId)];
  const worktreePath = findTaskWorktree(projectPath, specId);
  if (worktreePath) dirs.push(path.join(worktreePath, specsBaseDir, specId));
  return dirs;
}

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return safeParseJson<T>(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

interface PlanLike {
  phases?: Array<{ subtasks?: Array<{ status?: string }>; chunks?: Array<{ status?: string }> }>;
  failureReason?: unknown;
}

/** Every subtask status found in the implementation plans of these spec dirs. */
export function readSubtaskStatuses(specDirs: string[]): Array<{ status?: string }> {
  const out: Array<{ status?: string }> = [];
  for (const dir of specDirs) {
    const plan = readJson<PlanLike>(path.join(dir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN));
    for (const phase of plan?.phases ?? []) {
      for (const s of phase.subtasks ?? phase.chunks ?? []) out.push({ status: s?.status });
    }
  }
  return out;
}

/**
 * Why the task failed, as recorded: `failureReason` on a plan (written from
 * the state machine's error when it entered `error`), else the newest failed
 * `phase_end` message in task_logs.json ("Failed <phase> phase: <reason>").
 * Undefined when nothing was recorded.
 */
export function readFailureReason(specDirs: string[]): string | undefined {
  for (const dir of specDirs) {
    const plan = readJson<PlanLike>(path.join(dir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN));
    if (typeof plan?.failureReason === 'string' && plan.failureReason.trim() !== '') {
      return plan.failureReason.trim();
    }
  }

  let newest: { reason: string; at: string } | undefined;
  for (const dir of specDirs) {
    const logs = readJson<TaskLogs>(path.join(dir, 'task_logs.json'));
    for (const phase of Object.values(logs?.phases ?? {})) {
      for (const entry of phase?.entries ?? []) {
        if (entry?.type !== 'phase_end') continue;
        const reason = reasonFromPhaseEndMessage(entry.content);
        if (reason && (!newest || (entry.timestamp ?? '') > newest.at)) {
          newest = { reason, at: entry.timestamp ?? '' };
        }
      }
    }
  }
  return newest?.reason;
}
