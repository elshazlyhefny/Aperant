import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { app } from 'electron';
import { DEFAULT_APP_SETTINGS, DEFAULT_FEATURE_MODELS, DEFAULT_FEATURE_THINKING, MODEL_ID_MAP, THINKING_BUDGET_MAP } from '../../../shared/constants';
import type { AppSettings } from '../../../shared/types';
import { getToolPath } from '../../cli-tool-manager';
import { fixMisconfiguredBareRepo, GIT_BRANCH_REGEX } from '../../utils/git-repo-repair';
export { fixMisconfiguredBareRepo, GIT_BRANCH_REGEX };

// zeenha fork: async git helpers below keep the main thread free while Human Review loads.
const execFileAsync = promisify(execFile);

/**
 * Read utility feature settings (for commit message, merge resolver) from settings file
 */
export function getUtilitySettings(): { model: string; modelId: string; thinkingLevel: string; thinkingBudget: number | null } {
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');

  try {
    if (existsSync(settingsPath)) {
      const content = readFileSync(settingsPath, 'utf-8');
      const settings: AppSettings = { ...DEFAULT_APP_SETTINGS, ...JSON.parse(content) };

      // Get utility-specific settings
      const featureModels = settings.featureModels || DEFAULT_FEATURE_MODELS;
      const featureThinking = settings.featureThinking || DEFAULT_FEATURE_THINKING;

      const model = featureModels.utility || DEFAULT_FEATURE_MODELS.utility;
      const thinkingLevel = featureThinking.utility || DEFAULT_FEATURE_THINKING.utility;

      return {
        model,
        modelId: MODEL_ID_MAP[model] || MODEL_ID_MAP.haiku,
        thinkingLevel,
        thinkingBudget: thinkingLevel in THINKING_BUDGET_MAP ? THINKING_BUDGET_MAP[thinkingLevel] : THINKING_BUDGET_MAP.low
      };
    }
  } catch (error) {
    // Log parse errors to help diagnose corrupted settings
    console.warn('[getUtilitySettings] Failed to parse settings.json:', error);
  }

  // Return defaults if settings file doesn't exist or fails to parse
  return {
    model: DEFAULT_FEATURE_MODELS.utility,
    modelId: MODEL_ID_MAP[DEFAULT_FEATURE_MODELS.utility],
    thinkingLevel: DEFAULT_FEATURE_THINKING.utility,
    thinkingBudget: THINKING_BUDGET_MAP[DEFAULT_FEATURE_THINKING.utility]
  };
}

/**
 * Check if a path is a valid git working tree (not a bare repository).
 * Returns true if the path is inside a git repository with a working tree.
 *
 * NOTE: This is a pure check with no side-effects. If you need to fix
 * misconfigured bare repos before an operation, call fixMisconfiguredBareRepo()
 * explicitly before calling this function.
 *
 * @param projectPath - Path to check
 * @returns true if it's a valid working tree, false if bare or not a git repo
 */
export function isGitWorkTree(projectPath: string): boolean {
  try {
    // Use git rev-parse --is-inside-work-tree which returns "true" for working trees
    // and fails for bare repos or non-git directories
    const result = execFileSync(
      getToolPath('git'),
      ['rev-parse', '--is-inside-work-tree'],
      { cwd: projectPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return result.trim() === 'true';
  } catch {
    // Not a working tree (could be bare repo or not a git repo at all)
    return false;
  }
}

/**
 * Read the stored base branch from task_metadata.json
 * This is the branch the task was created from (set by user during task creation)
 */
export function getTaskBaseBranch(specDir: string): string | undefined {
  // Defensive check for undefined input
  if (!specDir || typeof specDir !== 'string') {
    console.error('[getTaskBaseBranch] specDir is undefined or not a string');
    return undefined;
  }

  try {
    const metadataPath = path.join(specDir, 'task_metadata.json');
    if (existsSync(metadataPath)) {
      const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8'));
      // Return baseBranch if explicitly set (not the __project_default__ marker)
      // Also validate it's a valid branch name to prevent malformed git commands
      if (metadata.baseBranch &&
          metadata.baseBranch !== '__project_default__' &&
          GIT_BRANCH_REGEX.test(metadata.baseBranch)) {
        // Strip remote prefix if present (e.g., "origin/feat/x" → "feat/x")
        const branch = metadata.baseBranch.replace(/^origin\//, '');
        return branch;
      }
    }
  } catch (e) {
    console.warn('[getTaskBaseBranch] Failed to read task metadata:', e);
  }
  return undefined;
}

/**
 * Get the effective base branch for a task with proper fallback chain.
 * Priority:
 * 1. Task metadata baseBranch (explicit task-level override from task_metadata.json)
 * 2. Project settings mainBranch (project-level default)
 * 3. Git default branch detection (main/master)
 * 4. Fallback to 'main'
 *
 * This should be used instead of getting the current HEAD branch,
 * as the user may be on a feature branch when viewing worktree status.
 */
export function getEffectiveBaseBranch(projectPath: string, specId: string, projectMainBranch?: string): string {
  // Defensive check for undefined inputs
  if (!projectPath || typeof projectPath !== 'string') {
    console.error('[getEffectiveBaseBranch] projectPath is undefined or not a string');
    return 'main';
  }
  if (!specId || typeof specId !== 'string') {
    console.error('[getEffectiveBaseBranch] specId is undefined or not a string');
    return 'main';
  }

  // 1. Try task metadata baseBranch
  const specDir = path.join(projectPath, '.auto-claude', 'specs', specId);
  const taskBaseBranch = getTaskBaseBranch(specDir);
  if (taskBaseBranch) {
    return taskBaseBranch;
  }

  // 2. Try project settings mainBranch
  if (projectMainBranch && GIT_BRANCH_REGEX.test(projectMainBranch)) {
    return projectMainBranch;
  }

  // 3. Try to detect main/master branch
  for (const branch of ['main', 'master']) {
    try {
      execFileSync(getToolPath('git'), ['rev-parse', '--verify', branch], {
        cwd: projectPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return branch;
    } catch {
      // Branch doesn't exist, try next
    }
  }

  // 4. Fallback to 'main'
  return 'main';
}

/**
 * zeenha fork: async version of getEffectiveBaseBranch. Same priority chain,
 * but git probes do not block the Electron main thread.
 */
export async function getEffectiveBaseBranchAsync(
  projectPath: string,
  specId: string,
  projectMainBranch?: string
): Promise<string> {
  if (!projectPath || typeof projectPath !== 'string') {
    console.error('[getEffectiveBaseBranchAsync] projectPath is undefined or not a string');
    return 'main';
  }
  if (!specId || typeof specId !== 'string') {
    console.error('[getEffectiveBaseBranchAsync] specId is undefined or not a string');
    return 'main';
  }

  const specDir = path.join(projectPath, '.auto-claude', 'specs', specId);
  const taskBaseBranch = getTaskBaseBranch(specDir);
  if (taskBaseBranch) {
    return taskBaseBranch;
  }

  if (projectMainBranch && GIT_BRANCH_REGEX.test(projectMainBranch)) {
    return projectMainBranch;
  }

  // main is preferred over master, so probe sequentially
  for (const branch of ['main', 'master']) {
    try {
      await execFileAsync(getToolPath('git'), ['rev-parse', '--verify', branch], {
        cwd: projectPath,
        encoding: 'utf-8',
      });
      return branch;
    } catch {
      // Branch doesn't exist, try next
    }
  }

  return 'main';
}

export interface NumstatEntry {
  path: string;
  additions: number;
  deletions: number;
}

/**
 * zeenha fork: parse `git diff --numstat` output. Binary files ('-') count as 0.
 */
export function parseNumstat(output: string): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    entries.push({
      path: parts.slice(2).join('\t'),
      additions: parseInt(parts[0], 10) || 0,
      deletions: parseInt(parts[1], 10) || 0,
    });
  }
  return entries;
}

export function summarizeNumstat(entries: NumstatEntry[]): {
  filesChanged: number;
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const entry of entries) {
    additions += entry.additions;
    deletions += entry.deletions;
  }
  return { filesChanged: entries.length, additions, deletions };
}

// zeenha fork: in-flight dedupe only (no TTL), so nothing stale is served after a call settles.
const inFlightNumstat = new Map<string, Promise<string>>();

/**
 * Run `git diff --numstat <baseBranch>` in a worktree without blocking the main thread.
 * Concurrent identical calls share one git process. Errors propagate to the caller.
 */
export function getWorktreeNumstat(worktreePath: string, baseBranch: string): Promise<string> {
  const key = `${worktreePath}\0${baseBranch}`;
  const existing = inFlightNumstat.get(key);
  if (existing) {
    return existing;
  }

  const promise = execFileAsync(getToolPath('git'), ['diff', '--numstat', baseBranch], {
    cwd: worktreePath,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  })
    .then(({ stdout }) => stdout.trim())
    .finally(() => {
      inFlightNumstat.delete(key);
    });

  inFlightNumstat.set(key, promise);
  return promise;
}
