/**
 * Task base branch resolution.
 *
 * zeenha fork: this module exists to be the single source of truth for which
 * branch a task is based on. Every caller (worktree status, merge, PR, diff,
 * etc.) must use resolveTaskBaseBranch() so they all agree on precedence:
 *
 *   1. explicit override (normalised)
 *   2. task_metadata.json baseBranch
 *   3. project settings mainBranch
 *   4. detected trunk branch (main, then master)
 *   5. 'main'
 */

import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { getToolPath } from './cli-tool-manager';
import { getIsolatedGitEnv } from './utils/git-isolation';
import type { Project } from '../shared/types';

import { GIT_BRANCH_REGEX } from './utils/git-repo-repair';

export { GIT_BRANCH_REGEX };

const execFileAsync = promisify(execFile);

const PROJECT_DEFAULT_MARKER = '__project_default__';

export type BaseBranchSource = 'override' | 'task_metadata' | 'project_settings' | 'detected' | 'fallback';

export interface ResolvedBaseBranch {
  branch: string;
  source: BaseBranchSource;
}

export interface ResolveTaskBaseBranchOptions {
  project: Pick<Project, 'path' | 'autoBuildPath' | 'settings'> | {
    path: string;
    autoBuildPath?: string;
    settings?: { mainBranch?: string };
  };
  specId: string;
  override?: string;
}

/**
 * Trim and validate a branch name; strips a leading "origin/".
 * Returns undefined for empty, the project-default marker, or invalid names.
 */
export function normalizeBranchName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === PROJECT_DEFAULT_MARKER) return undefined;
  if (!GIT_BRANCH_REGEX.test(trimmed)) return undefined;
  const stripped = trimmed.replace(/^origin\//, '');
  return stripped || undefined;
}

/**
 * Read the stored base branch from task_metadata.json
 * (the branch the task was created from).
 */
export function getTaskBaseBranch(specDir: string): string | undefined {
  if (!specDir || typeof specDir !== 'string') {
    console.error('[getTaskBaseBranch] specDir is undefined or not a string');
    return undefined;
  }

  try {
    const metadataPath = path.join(specDir, 'task_metadata.json');
    if (existsSync(metadataPath)) {
      const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8'));
      return normalizeBranchName(metadata.baseBranch);
    }
  } catch (e) {
    console.warn('[getTaskBaseBranch] Failed to read task metadata:', e);
  }
  return undefined;
}

/**
 * Detect the trunk branch of a repository: 'main' if it exists, else 'master'.
 */
export function detectTrunkBranch(projectPath: string): 'main' | 'master' | undefined {
  if (!projectPath || typeof projectPath !== 'string') return undefined;
  for (const branch of ['main', 'master'] as const) {
    try {
      execFileSync(getToolPath('git'), ['rev-parse', '--verify', branch], {
        cwd: projectPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: getIsolatedGitEnv(),
      });
      return branch;
    } catch {
      // Branch doesn't exist, try next
    }
  }
  return undefined;
}

/**
 * zeenha fork: async detectTrunkBranch, so the probe does not block the main thread.
 */
export async function detectTrunkBranchAsync(projectPath: string): Promise<'main' | 'master' | undefined> {
  if (!projectPath || typeof projectPath !== 'string') return undefined;
  // main is preferred over master, so probe sequentially
  for (const branch of ['main', 'master'] as const) {
    try {
      await execFileAsync(getToolPath('git'), ['rev-parse', '--verify', branch], {
        cwd: projectPath,
        encoding: 'utf-8',
        env: getIsolatedGitEnv(),
      });
      return branch;
    } catch {
      // Branch doesn't exist, try next
    }
  }
  return undefined;
}

/**
 * Steps 1-3 of the precedence (no git). Returns undefined when trunk detection is needed.
 */
function resolveWithoutGit(options: ResolveTaskBaseBranchOptions): ResolvedBaseBranch | undefined {
  const { project, specId, override } = options;

  const overrideBranch = normalizeBranchName(override);
  if (overrideBranch) return { branch: overrideBranch, source: 'override' };

  const projectPath = project?.path;
  const validPath = typeof projectPath === 'string' && projectPath.length > 0;
  const validSpecId = typeof specId === 'string' && specId.length > 0;

  if (validPath && validSpecId) {
    const specDir = path.join(projectPath, project.autoBuildPath || '.auto-claude', 'specs', specId);
    const taskBranch = getTaskBaseBranch(specDir);
    if (taskBranch) return { branch: taskBranch, source: 'task_metadata' };
  } else {
    console.error('[resolveTaskBaseBranch] project path or specId is undefined or not a string');
  }

  const settingsBranch = normalizeBranchName(project?.settings?.mainBranch);
  if (settingsBranch) return { branch: settingsBranch, source: 'project_settings' };

  return undefined;
}

function hasProjectPath(options: ResolveTaskBaseBranchOptions): boolean {
  const projectPath = options.project?.path;
  return typeof projectPath === 'string' && projectPath.length > 0;
}

/**
 * Resolve a task's base branch and report where the answer came from.
 */
export function resolveTaskBaseBranchWithSource(options: ResolveTaskBaseBranchOptions): ResolvedBaseBranch {
  const resolved = resolveWithoutGit(options);
  if (resolved) return resolved;

  if (hasProjectPath(options)) {
    const detected = detectTrunkBranch(options.project.path);
    if (detected) return { branch: detected, source: 'detected' };
  }

  return { branch: 'main', source: 'fallback' };
}

/**
 * zeenha fork: async resolveTaskBaseBranch with the same precedence, for IPC handlers
 * that must not block the Electron main thread.
 */
export async function resolveTaskBaseBranchAsync(options: ResolveTaskBaseBranchOptions): Promise<string> {
  const resolved = resolveWithoutGit(options);
  if (resolved) return resolved.branch;

  if (hasProjectPath(options)) {
    const detected = await detectTrunkBranchAsync(options.project.path);
    if (detected) return detected;
  }

  return 'main';
}

export function resolveTaskBaseBranch(options: ResolveTaskBaseBranchOptions): string {
  return resolveTaskBaseBranchWithSource(options).branch;
}
