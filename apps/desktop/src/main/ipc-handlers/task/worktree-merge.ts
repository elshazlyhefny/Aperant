import path from 'path';
import { existsSync, promises as fsPromises } from 'fs';
import { execFileSync, execFile } from 'child_process';
import { promisify } from 'util';
import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS, AUTO_BUILD_PATHS } from '../../../shared/constants';
import type { IPCResult, Project, Task, WorktreeMergeResult } from '../../../shared/types';
import { MergeOrchestrator } from '../../ai/merge/orchestrator';
import { pruneFinishedTask } from '../../ai/merge/file-evolution';
import { createMergeResolverFn } from '../../ai/runners/merge-resolver';
import type { ModelShorthand } from '../../ai/config/types';
import { findTaskAndProject } from './shared';
import { getToolPath } from '../../cli-tool-manager';
import { findTaskWorktree } from '../../worktree-paths';
import { withRetry } from './worktree-pr';
import { getIsolatedGitEnv } from '../../utils/git-isolation';
import { cleanupWorktree } from '../../utils/worktree-cleanup';
import { landsThroughPullRequestsOnly, PR_ONLY_LANDING_MESSAGE } from '../../../shared/utils/landing-policy';
import { taskStateManager } from '../../task-state-manager';
import { getUtilitySettings, fixMisconfiguredBareRepo, isGitWorkTree, getTaskBaseBranch } from './worktree-git-utils';

const execFileAsync = promisify(execFile);

type DebugFn = (...args: unknown[]) => void;
type EmitProgressFn = (stage: string, percent: number, message: string, details?: Record<string, unknown>) => void;

export interface MergeContext {
  specDir: string;
  worktreePath: string | null;
  effectiveBaseBranch: string;
}

export interface MergeOutcome {
  newStatus: string;
  planStatus: string;
  message: string;
  staged: boolean;
  reviewReason: string | undefined;
  cleanupWorktree: boolean;
}

/** Debug logger, active only in debug/development mode. */
export function createMergeDebug(): DebugFn {
  const isDebugMode = process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development';
  return (...args: unknown[]) => {
    if (isDebugMode) {
      console.warn('[MERGE DEBUG]', ...args);
    }
  };
}

/** Resolve spec dir, worktree path and base branch; repairs a misconfigured bare repo. */
export function resolveMergeContext(project: Project, task: Task, debug: DebugFn): MergeContext {
  const specDir = path.join(project.path, project.autoBuildPath || '.auto-claude', 'specs', task.specId);
  const worktreePath = findTaskWorktree(project.path, task.specId);

  // Auto-fix any misconfigured bare repo before merge operation
  // This prevents issues where git operations fail due to incorrect bare=true config
  if (fixMisconfiguredBareRepo(project.path)) {
    debug('Fixed misconfigured bare repository at:', project.path);
  }

  // Determine base branch with proper priority:
  // 1. Task metadata baseBranch (explicit task-level override)
  // 2. Project settings mainBranch (project-level default)
  // 3. Default to 'main'
  const taskBaseBranch = getTaskBaseBranch(specDir);
  const projectMainBranch = project.settings?.mainBranch;
  const effectiveBaseBranch = taskBaseBranch || projectMainBranch || 'main';
  debug('Using base branch:', effectiveBaseBranch,
    `(source: ${taskBaseBranch ? 'task metadata' : projectMainBranch ? 'project settings' : 'default'})`);

  return { specDir, worktreePath, effectiveBaseBranch };
}

/** Create a function that sends merge progress events to the renderer. */
export function createProgressEmitter(
  getMainWindow: () => BrowserWindow | null,
  taskId: string
): EmitProgressFn {
  const mainWindow = getMainWindow();
  return (stage, percent, message, details = {}) => {
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.TASK_MERGE_PROGRESS, taskId, {
        type: 'progress',
        stage,
        percent,
        message,
        details
      });
    }
  };
}

/** Run the merge orchestrator and stage the result in the project directory. */
export async function runMergeEngine(args: {
  project: Project;
  task: Task;
  worktreePath: string | null;
  baseBranch: string;
  emitProgress: EmitProgressFn;
  debug: DebugFn;
}): Promise<{ mergeSucceeded: boolean; mergeError: string | undefined }> {
  const { project, task, worktreePath, baseBranch, emitProgress, debug } = args;

  // Get utility settings for merge resolver model selection
  const utilitySettings = getUtilitySettings();
  debug('Utility settings for merge:', utilitySettings);

  // Emit initial progress event so renderer shows the merge has started
  emitProgress('analyzing', 0, 'Starting merge engine');

  // Build the AI resolver function using the merge-resolver runner
  const modelShorthand = (utilitySettings.model as ModelShorthand) || 'haiku';
  const aiResolverFn = createMergeResolverFn(modelShorthand, 'low');

  // Create the merge orchestrator
  const storageDir = path.join(project.path, project.autoBuildPath || '.auto-claude');
  const orchestrator = new MergeOrchestrator({
    projectDir: project.path,
    storageDir,
    enableAi: true,
    aiResolver: aiResolverFn,
    dryRun: false,
  });

  // Run the merge with progress callbacks
  let mergeSucceeded = false;
  let mergeError: string | undefined;

  try {
    const report = await orchestrator.mergeTask(
      task.specId,
      worktreePath ?? undefined,
      baseBranch,
      (stage, percent, message, details) => {
        emitProgress(stage, percent, message, details ?? {});
      }
    );

    debug('Merge report:', {
      success: report.success,
      stats: report.stats,
      error: report.error,
      fileResults: report.fileResults.size
    });

    if (report.success) {
      // Apply merged content to the project directory
      const applied = orchestrator.applyToProject(report);
      debug('Applied merge to project:', applied);

      if (applied) {
        stageAllChanges(project.path, debug);
        mergeSucceeded = true;
      } else {
        mergeError = 'Failed to apply merged files to project directory';
      }
    } else {
      mergeError = report.error ?? 'Merge failed';
    }
  } catch (err) {
    mergeError = err instanceof Error ? err.message : String(err);
    debug('Merge orchestrator threw:', mergeError);
    emitProgress('error', 0, `Merge failed: ${mergeError}`);
  }

  return { mergeSucceeded, mergeError };
}

/** Stage all changed files (failure is logged, not fatal). */
function stageAllChanges(projectPath: string, debug: DebugFn): void {
  try {
    execFileSync(getToolPath('git'), ['add', '-A'], {
      cwd: projectPath,
      encoding: 'utf-8',
      env: getIsolatedGitEnv()
    });
    debug('Staged merged files');
  } catch (gitErr) {
    debug('Failed to stage merged files:', gitErr);
  }
}

/** Log git status after merge (only if project is a working tree, not a bare repo). */
export function logPostMergeGitStatus(projectPath: string, debug: DebugFn): void {
  if (isGitWorkTree(projectPath)) {
    try {
      const gitStatusAfter = execFileSync(getToolPath('git'), ['status', '--short'], { cwd: projectPath, encoding: 'utf-8' });
      debug('Git status AFTER merge in main project:\n', gitStatusAfter || '(clean)');
      const gitDiffStaged = execFileSync(getToolPath('git'), ['diff', '--staged', '--stat'], { cwd: projectPath, encoding: 'utf-8' });
      debug('Staged changes:\n', gitDiffStaged || '(none)');
    } catch (e) {
      debug('Failed to get git status after:', e);
    }
  } else {
    debug('Project is a bare repository - skipping git status check (this is normal for worktree-based projects)');
  }
}

/**
 * Verify changes were actually staged when stage-only mode is requested.
 * This prevents false positives when merge was already committed previously.
 */
export function verifyStagedChanges(
  projectPath: string,
  specId: string,
  debug: DebugFn
): { hasActualStagedChanges: boolean; mergeAlreadyCommitted: boolean } {
  let hasActualStagedChanges = false;
  let mergeAlreadyCommitted = false;

  // Only check staged changes if project is a working tree (not bare repo)
  if (!isGitWorkTree(projectPath)) {
    // For bare repos, skip staging verification - merge happens in worktree
    debug('Project is a bare repository - skipping staged changes verification');
    return { hasActualStagedChanges, mergeAlreadyCommitted };
  }

  try {
    const gitDiffStaged = execFileSync(getToolPath('git'), ['diff', '--staged', '--stat'], { cwd: projectPath, encoding: 'utf-8' });
    hasActualStagedChanges = gitDiffStaged.trim().length > 0;
    debug('Stage-only verification: hasActualStagedChanges:', hasActualStagedChanges);

    if (!hasActualStagedChanges) {
      // Check if worktree branch was already merged (merge commit exists)
      const specBranch = `auto-claude/${specId}`;
      try {
        // Check if current branch contains all commits from spec branch
        // git merge-base --is-ancestor returns exit code 0 if true, 1 if false
        execFileSync(
          getToolPath('git'),
          ['merge-base', '--is-ancestor', specBranch, 'HEAD'],
          { cwd: projectPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
        );
        // If we reach here, the command succeeded (exit code 0) - branch is merged
        mergeAlreadyCommitted = true;
        debug('Merge already committed check:', mergeAlreadyCommitted);
      } catch {
        // Exit code 1 means not merged, or branch may not exist
        mergeAlreadyCommitted = false;
        debug('Could not check merge status, assuming not merged');
      }
    }
  } catch (e) {
    debug('Failed to verify staged changes:', e);
  }

  return { hasActualStagedChanges, mergeAlreadyCommitted };
}

/** Pure decision: what status/message to report after a successful merge. */
export function decideMergeOutcome(args: {
  isStageOnly: boolean;
  hasActualStagedChanges: boolean;
  mergeAlreadyCommitted: boolean;
}): MergeOutcome {
  const { isStageOnly, hasActualStagedChanges, mergeAlreadyCommitted } = args;

  if (isStageOnly && !hasActualStagedChanges && mergeAlreadyCommitted) {
    // Stage-only was requested but merge was already committed previously
    // Keep in human_review and let user explicitly mark as done (which will trigger cleanup confirmation)
    // This ensures user is in control of when the worktree is deleted
    // NOTE: We intentionally do NOT auto-clean the worktree here.
    // User can drag the task to "Done" column which will show a confirmation dialog
    // asking if they want to delete the worktree and mark complete.
    return {
      newStatus: 'human_review',
      planStatus: 'review',
      message: 'Changes were already merged and committed. You can mark this task as complete when ready.',
      staged: false,
      reviewReason: 'completed',
      cleanupWorktree: false,
    };
  }
  if (isStageOnly && !hasActualStagedChanges) {
    // Stage-only was requested but no changes to stage (and not committed)
    // This could mean nothing to merge or an error - keep in human_review for investigation
    return {
      newStatus: 'human_review',
      planStatus: 'review',
      message: 'No changes to stage. The worktree may have no differences from the current branch.',
      staged: false,
      reviewReason: 'completed',
      cleanupWorktree: false,
    };
  }
  if (isStageOnly) {
    // Stage-only with actual staged changes - expected success case
    return {
      newStatus: 'human_review',
      planStatus: 'review',
      message: 'Changes staged in main project. Review with git status and commit when ready.',
      staged: true,
      reviewReason: 'completed',
      cleanupWorktree: false,
    };
  }
  // Full merge (not stage-only)
  return {
    newStatus: 'done',
    planStatus: 'completed',
    message: 'Changes merged successfully',
    staged: false,
    reviewReason: undefined,
    cleanupWorktree: true,
  };
}

/**
 * Clean up worktree after successful full merge (fixes #243).
 * This allows drag-to-Done workflow since TASK_UPDATE_STATUS blocks 'done' when worktree exists.
 * Uses shared cleanup utility for robust Windows support (fixes #1539).
 */
export async function cleanupAfterFullMerge(args: {
  worktreePath: string | null;
  projectPath: string;
  specId: string;
  debug: DebugFn;
}): Promise<void> {
  const { worktreePath, projectPath, specId, debug } = args;
  if (!worktreePath || !existsSync(worktreePath)) {
    return;
  }

  const cleanupResult = await cleanupWorktree({
    worktreePath,
    projectPath,
    specId,
    logPrefix: '[TASK_WORKTREE_MERGE]',
    deleteBranch: true
  });

  if (cleanupResult.success) {
    debug('Worktree cleaned up after full merge:', worktreePath);
    if (cleanupResult.branch) {
      debug('Task branch deleted:', cleanupResult.branch);
    }
  } else {
    debug('Worktree cleanup failed (non-fatal):', cleanupResult.warnings);
    // Non-fatal - merge succeeded, cleanup can be done manually
  }

  // Log any warnings for debugging
  if (cleanupResult.warnings.length > 0) {
    debug('Cleanup warnings:', cleanupResult.warnings);
  }
}

/** Generate an AI commit message for the staged changes (failure is non-fatal). */
export async function suggestCommitMessage(
  project: Project,
  task: Task,
  debug: DebugFn
): Promise<string | undefined> {
  try {
    // Get diff summary and changed files for context
    let diffSummary = '';
    let filesChangedList: string[] = [];

    if (isGitWorkTree(project.path)) {
      try {
        const [diffResult, nameOnlyResult] = await Promise.all([
          execFileAsync(getToolPath('git'), ['diff', '--staged', '--stat'], { cwd: project.path, encoding: 'utf-8' }),
          execFileAsync(getToolPath('git'), ['diff', '--staged', '--name-only'], { cwd: project.path, encoding: 'utf-8' }),
        ]);
        diffSummary = diffResult.stdout.trim();
        const nameOnly = nameOnlyResult.stdout.trim();
        filesChangedList = nameOnly ? nameOnly.split('\n') : [];
      } catch (e) {
        debug('Failed to get staged diff for commit message:', e);
      }
    }

    const { generateCommitMessage } = await import('../../ai/runners/commit-message');
    const suggested = await generateCommitMessage({
      projectDir: project.path,
      specName: task.specId,
      diffSummary,
      filesChanged: filesChangedList,
    });
    debug('Generated commit message:', suggested?.substring(0, 100));
    return suggested;
  } catch (e) {
    debug('Failed to generate commit message:', e);
    return undefined;
  }
}

/**
 * Persist the status change to implementation_plan.json
 * Issue #243: We must update BOTH the main project's plan AND the worktree's plan (if it exists)
 * because ProjectStore prefers the worktree version when deduplicating tasks.
 * OPTIMIZATION: Use async I/O and parallel updates to prevent UI blocking
 * NOTE: The worktree has the same directory structure as main project
 */
export async function persistMergeStatus(args: {
  planPaths: { path: string; isMain: boolean }[];
  newStatus: string;
  planStatus: string;
  reviewReason: string | undefined;
  staged: boolean;
  debug: DebugFn;
}): Promise<void> {
  const { planPaths, newStatus, planStatus, reviewReason, staged, debug } = args;

  // Update plan file with retry logic for transient failures
  // Uses EAFP pattern (try/catch) instead of LBYL (existsSync check) to avoid TOCTOU race conditions
  const updatePlanWithRetry = async (planPath: string, isMain: boolean): Promise<boolean> => {
    // Helper to check if error is ENOENT (file not found)
    const isFileNotFound = (err: unknown): boolean =>
      !!(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT');

    try {
      await withRetry(
        async () => {
          const planContent = await fsPromises.readFile(planPath, 'utf-8');
          const plan = JSON.parse(planContent);
          plan.status = newStatus;
          plan.planStatus = planStatus;
          plan.reviewReason = reviewReason;
          plan.updated_at = new Date().toISOString();
          if (staged) {
            plan.stagedAt = new Date().toISOString();
            plan.stagedInMainProject = true;
          }
          await fsPromises.writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8');

          // Verify the write succeeded by reading back
          const verifyContent = await fsPromises.readFile(planPath, 'utf-8');
          const verifyPlan = JSON.parse(verifyContent);
          if (verifyPlan.status !== newStatus || verifyPlan.planStatus !== planStatus) {
            throw new Error('Write verification failed - status mismatch');
          }
        },
        {
          maxRetries: 3,
          baseDelayMs: 100,
          shouldRetry: (err) => !isFileNotFound(err) // Don't retry if file doesn't exist
        }
      );
      return true;
    } catch (err) {
      // File doesn't exist - nothing to update (not an error)
      if (isFileNotFound(err)) {
        return true;
      }
      // Only log error if main plan fails; worktree plan might legitimately be missing or read-only
      if (isMain) {
        console.error('Failed to persist task status to main plan after retries:', err);
      } else {
        debug('Failed to persist task status to worktree plan (non-critical):', err);
      }
      return false;
    }
  };

  const updatePlans = async () => {
    const results = await Promise.all(
      planPaths.map(({ path: planPath, isMain }) =>
        updatePlanWithRetry(planPath, isMain)
      )
    );
    // Log if main plan update failed (first element)
    if (!results[0]) {
      console.warn('Background plan update: main plan write may not have persisted');
    }
  };

  // IMPORTANT: Wait for plan updates to complete before responding (fixes #243)
  // Previously this was "fire and forget" which caused a race condition:
  // resolve() would return before files were written, and UI refresh would read old status
  try {
    await updatePlans();
  } catch (err) {
    debug('Plan update failed:', err);
    // Non-fatal: UI will still update, but status may not persist across refresh
  }
}

function buildPlanPaths(
  project: Project,
  task: Task,
  ctx: MergeContext
): { path: string; isMain: boolean }[] {
  const planPaths: { path: string; isMain: boolean }[] = [
    { path: path.join(ctx.specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN), isMain: true },
  ];
  // Add worktree plan path if worktree exists
  if (ctx.worktreePath) {
    const worktreeSpecDir = path.join(ctx.worktreePath, project.autoBuildPath || '.auto-claude', 'specs', task.specId);
    planPaths.push({ path: path.join(worktreeSpecDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN), isMain: false });
  }
  return planPaths;
}

/** Merge the worktree changes into the main branch (TASK_WORKTREE_MERGE). */
export async function handleWorktreeMerge(
  getMainWindow: () => BrowserWindow | null,
  taskId: string,
  options?: { noCommit?: boolean }
): Promise<IPCResult<WorktreeMergeResult>> {
  const debug = createMergeDebug();

  try {
    debug('Handler called with taskId:', taskId, 'options:', options);

    const { task, project } = findTaskAndProject(taskId);
    if (!task || !project) {
      debug('Task or project not found');
      return { success: false, error: 'Task not found' };
    }

    debug('Found task:', task.specId, 'project:', project.path);

    // zeenha fork: refuse before touching anything when the project lands
    // work through pull requests only (covers the stage-only option too).
    if (landsThroughPullRequestsOnly(project.settings)) {
      return { success: false, error: PR_ONLY_LANDING_MESSAGE };
    }

    const ctx = resolveMergeContext(project, task, debug);
    const emitProgress = createProgressEmitter(getMainWindow, taskId);

    const { mergeSucceeded, mergeError } = await runMergeEngine({
      project,
      task,
      worktreePath: ctx.worktreePath,
      baseBranch: ctx.effectiveBaseBranch,
      emitProgress,
      debug
    });

    // Post-merge: check git status, update plan files, clean worktree
    logPostMergeGitStatus(project.path, debug);

    if (!mergeSucceeded) {
      // Merge failed - return error to renderer
      debug('Merge failed. mergeError:', mergeError);
      return {
        success: true,
        data: {
          success: false,
          message: mergeError ?? 'Merge failed',
          conflictFiles: undefined
        }
      };
    }

    const isStageOnly = options?.noCommit === true;
    const verification = isStageOnly
      ? verifyStagedChanges(project.path, task.specId, debug)
      : { hasActualStagedChanges: false, mergeAlreadyCommitted: false };

    // Determine actual status based on verification
    const outcome = decideMergeOutcome({ isStageOnly, ...verification });
    const { newStatus, planStatus, message, staged, reviewReason } = outcome;
    if (isStageOnly && !verification.hasActualStagedChanges) {
      debug(verification.mergeAlreadyCommitted
        ? 'Stage-only requested but merge already committed. Keeping in human_review for user to confirm completion.'
        : 'Stage-only requested but no changes to stage.');
    }

    if (outcome.cleanupWorktree) {
      await cleanupAfterFullMerge({
        worktreePath: ctx.worktreePath,
        projectPath: project.path,
        specId: task.specId,
        debug
      });
      pruneFinishedTask(
        project.path,
        path.join(project.path, project.autoBuildPath || '.auto-claude'),
        task.specId
      );
    }

    debug('Merge result. isStageOnly:', isStageOnly, 'newStatus:', newStatus, 'staged:', staged);

    // Generate AI commit message if staging succeeded
    const suggestedCommitMessage = staged ? await suggestCommitMessage(project, task, debug) : undefined;

    await persistMergeStatus({
      planPaths: buildPlanPaths(project, task, ctx),
      newStatus,
      planStatus,
      reviewReason,
      staged,
      debug
    });

    // Route status change through TaskStateManager (XState) to avoid dual emission
    taskStateManager.handleManualStatusChange(taskId, newStatus as any, task, project);

    return {
      success: true,
      data: {
        success: true,
        message,
        staged,
        projectPath: staged ? project.path : undefined,
        suggestedCommitMessage
      }
    };
  } catch (error) {
    console.error('[MERGE] Exception in merge handler:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to merge worktree'
    };
  }
}
