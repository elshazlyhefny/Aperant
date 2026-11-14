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

import { getTaskBaseBranch, resolveTaskBaseBranch, resolveTaskBaseBranchAsync } from '../../base-branch';

export { getTaskBaseBranch };

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
 * Get the effective base branch for a task. Delegates to the shared resolver.
 * Canonical precedence:
 * 1. Task metadata baseBranch (task_metadata.json)
 * 2. Project settings mainBranch
 * 3. Git trunk detection (main, then master)
 * 4. Fallback to 'main'
 *
 * Prefer resolveTaskBaseBranch() from ../../base-branch in new code.
 */
export function getEffectiveBaseBranch(
  projectPath: string,
  specId: string,
  projectMainBranch?: string,
  autoBuildPath?: string
): string {
  return resolveTaskBaseBranch({
    project: { path: projectPath, autoBuildPath, settings: { mainBranch: projectMainBranch } },
    specId,
  });
}

/**
 * zeenha fork: async version of getEffectiveBaseBranch. Same precedence (shared
 * resolver), but git probes do not block the Electron main thread.
 */
export function getEffectiveBaseBranchAsync(
  projectPath: string,
  specId: string,
  projectMainBranch?: string,
  autoBuildPath?: string
): Promise<string> {
  return resolveTaskBaseBranchAsync({
    project: { path: projectPath, autoBuildPath, settings: { mainBranch: projectMainBranch } },
    specId,
  });
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
