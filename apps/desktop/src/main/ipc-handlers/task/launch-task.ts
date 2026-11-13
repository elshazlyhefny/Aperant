/**
 * Single place that launches a task agent: starts the file watcher and then
 * either spec creation or task execution. Callers (TASK_START, status update to
 * in_progress, stuck-task recovery) keep their own state-machine, timer and
 * subtask-reset handling.
 */
import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { AUTO_BUILD_PATHS, getSpecsDir } from '../../../shared/constants';
import type { Project, Task } from '../../../shared/types';
import type { AgentManager } from '../../agent';
import type { TaskExecutionOptions } from '../../agent/types';
import { fileWatcher } from '../../file-watcher';
import { checkGitStatus } from '../../project-initializer';
import { initializeClaudeProfileManager, type ClaudeProfileManager } from '../../claude-profile-manager';
import { findTaskWorktree } from '../../worktree-paths';
import { resolveTaskBaseBranch } from '../../base-branch';
import { hasUsableAuth } from '../../services/profile/provider-account-check';

/**
 * Safe file read that handles missing files without TOCTOU issues.
 * Returns null if file doesn't exist or can't be read.
 */
export function safeReadFileSync(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch (error) {
    // ENOENT (file not found) is expected, other errors should be logged
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[safeReadFileSync] Error reading ${filePath}:`, error);
    }
    return null;
  }
}

/**
 * Helper function to check subtask completion status
 */
export function checkSubtasksCompletion(plan: Record<string, unknown> | null): {
  allSubtasks: Array<{ status: string }>;
  completedCount: number;
  totalCount: number;
  allCompleted: boolean;
} {
  const allSubtasks = (plan?.phases as Array<{ subtasks?: Array<{ status: string }> }> | undefined)?.flatMap(phase =>
    phase.subtasks || []
  ) || [];
  const completedCount = allSubtasks.filter(s => s.status === 'completed').length;
  const totalCount = allSubtasks.length;
  const allCompleted = totalCount > 0 && completedCount === totalCount;

  return { allSubtasks, completedCount, totalCount, allCompleted };
}

/**
 * Helper function to ensure profile manager is initialized.
 * Returns a discriminated union for type-safe error handling.
 */
async function ensureProfileManagerInitialized(): Promise<
  | { success: true; profileManager: ClaudeProfileManager }
  | { success: false; error: string }
> {
  try {
    const profileManager = await initializeClaudeProfileManager();
    return { success: true, profileManager };
  } catch (error) {
    console.error('[ensureProfileManagerInitialized] Failed to initialize:', error);
    // Include actual error details for debugging while providing actionable guidance
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to initialize profile manager. Please check file permissions and disk space. (${errorMessage})`
    };
  }
}

/**
 * Get the spec directory for file watching, preferring the worktree path if it exists.
 * When a task runs in a worktree, implementation_plan.json is written there,
 * not in the main project's spec directory.
 */
export function getSpecDirForWatcher(projectPath: string, specsBaseDir: string, specId: string): string {
  const worktreePath = findTaskWorktree(projectPath, specId);
  if (worktreePath) {
    const worktreeSpecDir = path.join(worktreePath, specsBaseDir, specId);
    if (existsSync(path.join(worktreeSpecDir, 'implementation_plan.json'))) {
      return worktreeSpecDir;
    }
  }
  return path.join(projectPath, specsBaseDir, specId);
}

/**
 * True when <specDir>/implementation_plan.json exists, parses, and has at
 * least one subtask. A missing or corrupt plan counts as "no subtasks".
 */
export function planHasSubtasks(specDir: string): boolean {
  const content = safeReadFileSync(path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN));
  if (!content) return false;
  try {
    return checkSubtasksCompletion(JSON.parse(content)).totalCount > 0;
  } catch {
    return false;
  }
}

/**
 * Base branch for a launch. Delegates to the shared resolver (task_metadata.json,
 * then project settings, then detected trunk, then 'main'), so it is never undefined.
 */
export function resolveBaseBranch(task: Task, project: Project): string {
  return resolveTaskBaseBranch({ project, specId: task.specId });
}

/** Options passed to startTaskExecution. Note: parallelism is handled inside the agent. */
export function buildExecutionOptions(task: Task, baseBranch: string | undefined): TaskExecutionOptions {
  return {
    parallel: false,
    workers: 1,
    baseBranch,
    useWorktree: task.metadata?.useWorktree,
    useLocalBranch: task.metadata?.useLocalBranch,
    pushNewBranches: task.metadata?.pushNewBranches
  };
}

export type PreflightResult =
  | { ok: true; profileManager: ClaudeProfileManager }
  | { ok: false; error: string };

/** Git repository, profile manager and authentication checks before launching. */
export async function preflightTaskLaunch(_task: Task, project: Project): Promise<PreflightResult> {
  const gitStatus = checkGitStatus(project.path);
  if (!gitStatus.isGitRepo) {
    return {
      ok: false,
      error: 'Git repository required. Please run "git init" in your project directory. Aperant uses git worktrees for isolated builds.'
    };
  }
  if (!gitStatus.hasCommits) {
    return {
      ok: false,
      error: 'Git repository has no commits. Please make an initial commit first (git add . && git commit -m "Initial commit").'
    };
  }

  const initResult = await ensureProfileManagerInitialized();
  if (!initResult.success) {
    return { ok: false, error: initResult.error };
  }
  if (!hasUsableAuth(initResult.profileManager)) {
    return {
      ok: false,
      error: 'Authentication required. Please add an account in Settings > Accounts before starting tasks.'
    };
  }
  return { ok: true, profileManager: initResult.profileManager };
}

export interface LaunchTaskResult {
  mode: 'spec_creation' | 'planning' | 'execution';
  hasSpec: boolean;
  planHasSubtasks: boolean;
}

export interface LaunchTaskParams {
  task: Task;
  project: Project;
  agentManager: Pick<AgentManager, 'startSpecCreation' | 'startTaskExecution'>;
  logTag: string;
  /** Precomputed by callers that need it earlier (TASK_START picks its XState event from it). */
  planHasSubtasks?: boolean;
}

export function launchTask(params: LaunchTaskParams): LaunchTaskResult {
  const { task, project, agentManager, logTag } = params;
  const taskId = task.id;
  const specsBaseDir = getSpecsDir(project.autoBuildPath);
  const specDir = path.join(project.path, specsBaseDir, task.specId);

  // Use the worktree spec dir if it exists, since the backend writes implementation_plan.json there
  const watchSpecDir = getSpecDirForWatcher(project.path, specsBaseDir, task.specId);
  fileWatcher.watch(taskId, watchSpecDir).catch((err) => {
    console.error(`${logTag} Failed to watch spec dir for ${taskId}:`, err);
  });

  // Spec is created in the main project path before any worktree exists
  const hasSpec = existsSync(path.join(specDir, AUTO_BUILD_PATHS.SPEC_FILE));
  // FIX (#1562): check the actual plan file for subtasks, not task.subtasks.length
  const hasSubtasks = params.planHasSubtasks ?? planHasSubtasks(specDir);
  const baseBranch = resolveBaseBranch(task, project);

  console.warn(`${logTag} hasSpec:`, hasSpec, 'planHasSubtasks:', hasSubtasks);

  if (!hasSpec) {
    console.warn(`${logTag} Starting spec creation for:`, task.specId, 'in:', specDir, 'baseBranch:', baseBranch);
    agentManager.startSpecCreation(
      taskId,
      project.path,
      task.description || task.title,
      specDir,
      task.metadata,
      baseBranch,
      project.id
    );
    return { mode: 'spec_creation', hasSpec, planHasSubtasks: hasSubtasks };
  }

  console.warn(
    `${logTag} Starting task execution (${hasSubtasks ? 'has subtasks' : 'no valid subtasks in plan'}) for:`,
    task.specId
  );
  agentManager.startTaskExecution(
    taskId,
    project.path,
    task.specId,
    buildExecutionOptions(task, baseBranch),
    project.id
  );
  return { mode: hasSubtasks ? 'execution' : 'planning', hasSpec, planHasSubtasks: hasSubtasks };
}
