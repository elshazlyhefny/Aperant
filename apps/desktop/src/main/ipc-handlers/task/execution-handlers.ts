import { ipcMain, BrowserWindow } from 'electron';
import { IPC_CHANNELS, AUTO_BUILD_PATHS, getSpecsDir } from '../../../shared/constants';
import type { IPCResult, TaskStartOptions, TaskStatus, ImageAttachment } from '../../../shared/types';
import path from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { spawnSync, execFileSync } from 'child_process';
import { getToolPath } from '../../cli-tool-manager';
import { AgentManager } from '../../agent';
import { fileWatcher } from '../../file-watcher';
import { findTaskAndProject } from './shared';
import { taskStateManager } from '../../task-state-manager';
import { taskQueueManager } from '../../task-queue-manager';
import {
  getPlanPath,
  persistPlanStatus,
  createPlanIfNotExists,
  resetStuckSubtasks,
  hasPlanWithSubtasks
} from './plan-file-utils';
import { writeFileAtomicSync } from '../../utils/atomic-file';
import { findTaskWorktree } from '../../worktree-paths';
import { projectStore } from '../../project-store';
import { getIsolatedGitEnv, detectWorktreeBranch } from '../../utils/git-isolation';
import { cancelFallbackTimer } from '../agent-events-handlers';
import { canMoveFailedTaskTo } from '../../../shared/utils/task-failure';
import { preflightTaskLaunch, launchTask, planHasSubtasks, safeReadFileSync, checkSubtasksCompletion } from './launch-task';

import { appLog } from '../../app-logger';

/**
 * Update task status manually. Callable from IPC and from the main-process queue manager.
 * Options:
 * - forceCleanup: When setting to 'done' with a worktree present, delete the worktree first
 */
export async function applyTaskStatusUpdate(
  agentManager: AgentManager,
  getMainWindow: () => BrowserWindow | null,
  taskId: string,
  status: TaskStatus,
  options?: { forceCleanup?: boolean; keepWorktree?: boolean }
): Promise<IPCResult & { worktreeExists?: boolean; worktreePath?: string }> {
  // Find task and project first (needed for worktree check)
  const { task, project } = findTaskAndProject(taskId);

  if (!task || !project) {
    return { success: false, error: 'Task not found' };
  }

  // zeenha fork: a Failed task did no work, so it cannot be put up for review.
  if (task.status === 'error' && status !== 'error' && !canMoveFailedTaskTo(status)) {
    return { success: false, error: 'A failed task cannot be moved to review: it has no work to review. Retry it, re-plan it, or move it to Backlog.' };
  }

  // Validate status transition - 'done' can only be set through merge handler
  // UNLESS there's no worktree (limbo state - already merged/discarded or failed)
  // OR forceCleanup is requested (user confirmed they want to delete the worktree)
  // OR keepWorktree is requested (user wants to mark done without deleting worktree)
  if (status === 'done') {
    // Check if worktree exists (task.specId matches worktree folder name)
    const worktreePath = findTaskWorktree(project.path, task.specId);
    const hasWorktree = worktreePath !== null;

    if (hasWorktree) {
      if (options?.keepWorktree) {
        // User explicitly chose to keep worktree - allow marking as done
        console.warn(`[TASK_UPDATE_STATUS] Marking task ${taskId} as done while keeping worktree at ${worktreePath}`);
      } else if (options?.forceCleanup) {
        // User confirmed cleanup - delete worktree and branch
        console.warn(`[TASK_UPDATE_STATUS] Cleaning up worktree for task ${taskId} (user confirmed)`);
        try {
          // Get the branch name before removing the worktree
          // Use shared utility to validate detected branch matches expected pattern
          // This prevents deleting wrong branch when worktree is corrupted/orphaned
          const { branch, usingFallback: usingFallbackBranch } = detectWorktreeBranch(
            worktreePath,
            task.specId,
            { timeout: 30000, logPrefix: '[TASK_UPDATE_STATUS]' }
          );

          // Remove the worktree
          execFileSync(getToolPath('git'), ['worktree', 'remove', '--force', worktreePath], {
            cwd: project.path,
            encoding: 'utf-8',
            timeout: 30000,
            env: getIsolatedGitEnv()
          });
          console.warn(`[TASK_UPDATE_STATUS] Worktree removed: ${worktreePath}`);

          // Delete the branch (ignore errors if branch doesn't exist)
          try {
            execFileSync(getToolPath('git'), ['branch', '-D', branch], {
              cwd: project.path,
              encoding: 'utf-8',
              timeout: 30000,
              env: getIsolatedGitEnv()
            });
            console.warn(`[TASK_UPDATE_STATUS] Branch deleted: ${branch}`);
          } catch (branchDeleteError) {
            // Branch may not exist or may be the current branch
            if (usingFallbackBranch) {
              // More concerning - fallback pattern didn't match actual branch
              console.warn(`[TASK_UPDATE_STATUS] Could not delete branch ${branch} using fallback pattern. Actual branch may still exist and need manual cleanup.`, branchDeleteError);
            } else {
              console.warn(
                `[TASK_UPDATE_STATUS] Could not delete branch ${branch} (may not exist or be checked out elsewhere)`,
                branchDeleteError
              );
            }
          }

          console.warn(`[TASK_UPDATE_STATUS] Worktree cleanup completed successfully`);
        } catch (cleanupError) {
          console.error(`[TASK_UPDATE_STATUS] Failed to cleanup worktree:`, cleanupError);
          return {
            success: false,
            error: `Failed to cleanup worktree: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
          };
        }
      } else {
        // Worktree exists but no forceCleanup - return special response for UI to show confirmation
        console.warn(`[TASK_UPDATE_STATUS] Worktree exists for task ${taskId}. Requesting user confirmation.`);
        return {
          success: false,
          worktreeExists: true,
          worktreePath: worktreePath,
          error: "A worktree still exists for this task. Would you like to delete it and mark the task as complete?"
        };
      }
    } else {
      // No worktree - allow marking as done (limbo state recovery)
      console.warn(`[TASK_UPDATE_STATUS] Allowing status 'done' for task ${taskId} (no worktree found - limbo state)`);
    }
  }

  // Validate status transition - 'human_review' requires actual work to have been done
  // This prevents tasks from being incorrectly marked as ready for review when execution failed
  if (status === 'human_review') {
    const specsBaseDirForValidation = getSpecsDir(project.autoBuildPath);
    const specDirForValidation = path.join(
      project.path,
      specsBaseDirForValidation,
      task.specId
    );
    const specFilePath = path.join(specDirForValidation, AUTO_BUILD_PATHS.SPEC_FILE);

    // Check if spec.md exists and has meaningful content (at least 100 chars)
    const MIN_SPEC_CONTENT_LENGTH = 100;
    let specContent = '';
    try {
      if (existsSync(specFilePath)) {
        specContent = readFileSync(specFilePath, 'utf-8');
      }
    } catch {
      // Ignore read errors - treat as empty spec
    }

    if (!specContent || specContent.length < MIN_SPEC_CONTENT_LENGTH) {
      console.warn(`[TASK_UPDATE_STATUS] Blocked attempt to set status 'human_review' for task ${taskId}. No spec has been created yet.`);
      return {
        success: false,
        error: "Cannot move to human review - no spec has been created yet. The task must complete processing before review."
      };
    }
  }

  // Get the plan path using shared utility
  const planPath = getPlanPath(project, task);

  try {
    const handledByMachine = taskStateManager.handleManualStatusChange(taskId, status, task, project);
    if (!handledByMachine) {
      // Use shared utility for thread-safe plan file updates (legacy/manual override)
      const persisted = await persistPlanStatus(planPath, status, project.id);

      if (!persisted) {
        // If no implementation plan exists yet, create a basic one
        await createPlanIfNotExists(planPath, task, status);
        // Invalidate cache after creating new plan
        projectStore.invalidateTasksCache(project.id);
      }
    }

    // Auto-stop task when status changes AWAY from 'in_progress' and process IS running
    // This handles the case where user drags a running task back to Planning/backlog
    if (status !== 'in_progress' && agentManager.isRunning(taskId)) {
      console.warn('[TASK_UPDATE_STATUS] Stopping task due to status change away from in_progress:', taskId);
      agentManager.killTask(taskId);
    }

    // Auto-start task when status changes to 'in_progress' and no process is running
    if (status === 'in_progress' && !agentManager.isRunning(taskId)) {
      // Clear stale tracking state before starting a new process
      taskStateManager.prepareForRestart(taskId);
      const mainWindow = getMainWindow();

      const pre = await preflightTaskLaunch(task, project);
      if (!pre.ok) {
        console.warn('[TASK_UPDATE_STATUS] Preflight failed, cannot auto-start task:', pre.error);
        if (mainWindow) {
          mainWindow.webContents.send(IPC_CHANNELS.TASK_ERROR, taskId, pre.error);
        }
        return { success: false, error: pre.error };
      }

      console.warn('[TASK_UPDATE_STATUS] Auto-starting task:', taskId);

      // Cancel any pending fallback timer from previous process exit
      // This prevents the stale timer from incorrectly stopping the newly started task
      cancelFallbackTimer(taskId);

      // Reset any stuck subtasks before starting execution
      // This handles recovery from previous rate limits or crashes
      const resetResult = await resetStuckSubtasks(planPath, project.id);
      if (resetResult.success && resetResult.resetCount > 0) {
        console.warn(`[TASK_UPDATE_STATUS] Reset ${resetResult.resetCount} stuck subtask(s) before starting`);
      }

      launchTask({ task, project, agentManager, logTag: '[TASK_UPDATE_STATUS]' });

      // Notify renderer about status change
      if (mainWindow) {
        mainWindow.webContents.send(
          IPC_CHANNELS.TASK_STATUS_CHANGE,
          taskId,
          'in_progress',
          project.id
        );
      }
    }

    // zeenha fork: the queue lives in main, so a task newly queued may fit a free slot right away
    if (status === 'queue') {
      void taskQueueManager.requestProcess(project.id);
    }

    return { success: true };
  } catch (error) {
    console.error('Failed to update task status:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update task status'
    };
  }
}

/**
 * Register task execution handlers (start, stop, review, status management, recovery)
 */
export function registerTaskExecutionHandlers(
  agentManager: AgentManager,
  getMainWindow: () => BrowserWindow | null
): void {
  /**
   * Start a task
   */
  ipcMain.on(
    IPC_CHANNELS.TASK_START,
    async (_, taskId: string, _options?: TaskStartOptions) => {
      console.warn('[TASK_START] Received request for taskId:', taskId);

      // Cancel any pending fallback timer from previous process exit
      // This prevents the stale timer from incorrectly stopping the newly restarted task
      cancelFallbackTimer(taskId);

      const mainWindow = getMainWindow();
      if (!mainWindow) {
        console.warn('[TASK_START] No main window found');
        return;
      }

      // Find task and project
      // First search all projects to find the task, then verify the project matches
      // task.projectId to prevent cross-project contamination when multiple projects
      // have tasks with overlapping specIds (e.g., after delete/recreate).
      const { task, project: foundProject } = findTaskAndProject(taskId);

      if (!task || !foundProject) {
        console.warn('[TASK_START] Task or project not found for taskId:', taskId);
        mainWindow.webContents.send(
          IPC_CHANNELS.TASK_ERROR,
          taskId,
          'Task or project not found'
        );
        return;
      }

      // Use task's own projectId as the authoritative source (prevents wrong-project execution)
      const project = (task.projectId && task.projectId !== foundProject.id)
        ? (projectStore.getProject(task.projectId) ?? foundProject)
        : foundProject;

      const pre = await preflightTaskLaunch(task, project);
      if (!pre.ok) {
        console.warn('[TASK_START] Preflight failed:', pre.error);
        mainWindow.webContents.send(IPC_CHANNELS.TASK_ERROR, taskId, pre.error);
        return;
      }

      console.warn('[TASK_START] Found task:', task.specId, 'status:', task.status, 'reviewReason:', task.reviewReason, 'subtasks:', task.subtasks.length);

      // Clear stale tracking state from any previous execution so that:
      // - terminalEventSeen doesn't suppress future PROCESS_EXITED events
      // - lastSequenceByTask doesn't drop events from the new process
      taskStateManager.prepareForRestart(taskId);

      const specsBaseDir = getSpecsDir(project.autoBuildPath);
      const specDir = path.join(
        project.path,
        specsBaseDir,
        task.specId
      );
      const hasSubtasks = planHasSubtasks(specDir);

      // Immediately mark as started so the UI moves the card to In Progress.
      // Use XState actor state as source of truth (if actor exists), with task data as fallback.
      // - plan_review: User approved the plan, send PLAN_APPROVED to transition to coding
      // - human_review/error: User resuming, send USER_RESUMED
      // - backlog/other: Fresh start, send PLANNING_STARTED
      const currentXState = taskStateManager.getCurrentState(taskId);
      console.warn('[TASK_START] Current XState:', currentXState, '| Task status:', task.status, task.reviewReason);

      if (currentXState === 'plan_review') {
        // XState says plan_review - send PLAN_APPROVED
        console.warn('[TASK_START] XState: plan_review -> coding via PLAN_APPROVED');
        taskStateManager.handleUiEvent(taskId, { type: 'PLAN_APPROVED' }, task, project);
      } else if (currentXState === 'error' && !hasSubtasks) {
        // FIX (#1562): Task crashed during planning (no subtasks yet).
        // Uses planHasSubtasks from implementation_plan.json (more reliable than task.subtasks.length).
        console.warn('[TASK_START] XState: error with no plan subtasks -> planning via PLANNING_STARTED');
        taskStateManager.handleUiEvent(taskId, { type: 'PLANNING_STARTED' }, task, project);
      } else if (currentXState === 'human_review' || currentXState === 'error') {
        // XState says human_review or error - send USER_RESUMED
        console.warn('[TASK_START] XState:', currentXState, '-> coding via USER_RESUMED');
        taskStateManager.handleUiEvent(taskId, { type: 'USER_RESUMED' }, task, project);
      } else if (currentXState) {
        // XState actor exists but in another state (coding, planning, etc.)
        // This shouldn't happen normally, but handle gracefully
        console.warn('[TASK_START] XState in unexpected state:', currentXState, '- sending PLANNING_STARTED');
        taskStateManager.handleUiEvent(taskId, { type: 'PLANNING_STARTED' }, task, project);
      } else if (task.status === 'human_review' && task.reviewReason === 'plan_review') {
        // No XState actor - fallback to task data (e.g., after app restart)
        console.warn('[TASK_START] No XState actor, task data: plan_review -> coding via PLAN_APPROVED');
        taskStateManager.handleUiEvent(taskId, { type: 'PLAN_APPROVED' }, task, project);
      } else if (task.status === 'error' && !hasSubtasks) {
        // FIX (#1562): No XState actor, task crashed during planning (no subtasks).
        // Uses planHasSubtasks from implementation_plan.json (more reliable than task.subtasks.length).
        console.warn('[TASK_START] No XState actor, error with no plan subtasks -> planning via PLANNING_STARTED');
        taskStateManager.handleUiEvent(taskId, { type: 'PLANNING_STARTED' }, task, project);
      } else if (task.status === 'human_review' || task.status === 'error') {
        // No XState actor - fallback to task data for resuming
        console.warn('[TASK_START] No XState actor, task data:', task.status, '-> coding via USER_RESUMED');
        taskStateManager.handleUiEvent(taskId, { type: 'USER_RESUMED' }, task, project);
      } else {
        // Fresh start - PLANNING_STARTED transitions from backlog to planning
        console.warn('[TASK_START] Fresh start via PLANNING_STARTED');
        taskStateManager.handleUiEvent(taskId, { type: 'PLANNING_STARTED' }, task, project);
      }

      // Reset any stuck subtasks before starting execution
      // This handles recovery from previous rate limits or crashes
      const planPath = getPlanPath(project, task);
      const resetResult = await resetStuckSubtasks(planPath, project.id);
      if (resetResult.success && resetResult.resetCount > 0) {
        console.warn(`[TASK_START] Reset ${resetResult.resetCount} stuck subtask(s) before starting`);
      }

      launchTask({ task, project, agentManager, logTag: '[TASK_START]', planHasSubtasks: hasSubtasks });
    }
  );

  /**
   * Stop a task
   */
  ipcMain.on(IPC_CHANNELS.TASK_STOP, (_, taskId: string) => {
    stopTask(agentManager, taskId);
  });

  /**
   * Review a task (approve or reject)
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_REVIEW,
    async (
      _,
      taskId: string,
      approved: boolean,
      feedback?: string,
      images?: ImageAttachment[]
    ): Promise<IPCResult> => {
      // Find task and project
      const { task, project } = findTaskAndProject(taskId);

      if (!task || !project) {
        return { success: false, error: 'Task not found' };
      }

      // Check if dev mode is enabled for this project
      const specsBaseDir = getSpecsDir(project.autoBuildPath);
      const specDir = path.join(
        project.path,
        specsBaseDir,
        task.specId
      );

      // Check if worktree exists - QA needs to run in the worktree where the build happened
      const worktreePath = findTaskWorktree(project.path, task.specId);
      const worktreeSpecDir = worktreePath ? path.join(worktreePath, specsBaseDir, task.specId) : null;
      const hasWorktree = worktreePath !== null;

      if (approved) {
        // Write approval to QA report
        const qaReportPath = path.join(specDir, AUTO_BUILD_PATHS.QA_REPORT);
        try {
          writeFileSync(
            qaReportPath,
            `# QA Review\n\nStatus: APPROVED\n\nReviewed at: ${new Date().toISOString()}\n`,
            'utf-8'
          );
        } catch (error) {
          console.error('[TASK_REVIEW] Failed to write QA report:', error);
          return { success: false, error: 'Failed to write QA report file' };
        }

        taskStateManager.handleUiEvent(
          taskId,
          { type: 'MARK_DONE' },
          task,
          project
        );
      } else {
        // Reset and discard all changes from worktree merge in main
        // The worktree still has all changes, so nothing is lost
        if (hasWorktree) {
          // Step 1: Unstage all changes
          const resetResult = spawnSync(getToolPath('git'), ['reset', 'HEAD'], {
            cwd: project.path,
            encoding: 'utf-8',
            stdio: 'pipe',
            env: getIsolatedGitEnv()
          });
          if (resetResult.status === 0) {
            appLog.info('[TASK_REVIEW] Unstaged changes in main');
          }

          // Step 2: Discard all working tree changes (restore to pre-merge state)
          const checkoutResult = spawnSync(getToolPath('git'), ['checkout', '--', '.'], {
            cwd: project.path,
            encoding: 'utf-8',
            stdio: 'pipe',
            env: getIsolatedGitEnv()
          });
          if (checkoutResult.status === 0) {
            appLog.info('[TASK_REVIEW] Discarded working tree changes in main');
          }

          // Step 3: Clean untracked files that came from the merge
          // IMPORTANT: Exclude .auto-claude directory to preserve specs and worktree data
          const cleanResult = spawnSync(getToolPath('git'), ['clean', '-fd', '-e', '.auto-claude'], {
            cwd: project.path,
            encoding: 'utf-8',
            stdio: 'pipe',
            env: getIsolatedGitEnv()
          });
          if (cleanResult.status === 0) {
            appLog.info('[TASK_REVIEW] Cleaned untracked files in main (excluding .auto-claude)');
          }

          appLog.info('[TASK_REVIEW] Main branch restored to pre-merge state');
        }

        // Write feedback for QA fixer - write to WORKTREE spec dir if it exists
        // The QA process runs in the worktree where the build and implementation_plan.json are
        const targetSpecDir = hasWorktree && worktreeSpecDir ? worktreeSpecDir : specDir;
        const fixRequestPath = path.join(targetSpecDir, 'QA_FIX_REQUEST.md');

        console.warn('[TASK_REVIEW] Writing QA fix request to:', fixRequestPath);
        console.warn('[TASK_REVIEW] hasWorktree:', hasWorktree, 'worktreePath:', worktreePath);

        // Process images if provided
        let imageReferences = '';
        if (images && images.length > 0) {
          const imagesDir = path.join(targetSpecDir, 'feedback_images');
          try {
            if (!existsSync(imagesDir)) {
              mkdirSync(imagesDir, { recursive: true });
            }
            const savedImages: string[] = [];
            for (const image of images) {
              try {
                if (!image.data) {
                  console.warn('[TASK_REVIEW] Skipping image with no data:', image.filename);
                  continue;
                }
                // Server-side MIME type validation (defense in depth - frontend also validates)
                // Reject missing mimeType to prevent bypass attacks
                const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/svg+xml'];
                if (!image.mimeType || !ALLOWED_MIME_TYPES.includes(image.mimeType)) {
                  console.warn('[TASK_REVIEW] Skipping image with missing or disallowed MIME type:', image.mimeType);
                  continue;
                }
                // Sanitize filename to prevent path traversal attacks
                const sanitizedFilename = path.basename(image.filename);
                if (!sanitizedFilename || sanitizedFilename === '.' || sanitizedFilename === '..') {
                  console.warn('[TASK_REVIEW] Skipping image with invalid filename:', image.filename);
                  continue;
                }
                // Remove data URL prefix if present (e.g., "data:image/png;base64," or "data:image/svg+xml;base64,")
                const base64Data = image.data.replace(/^data:image\/[^;]+;base64,/, '');
                const imageBuffer = Buffer.from(base64Data, 'base64');
                const imagePath = path.join(imagesDir, sanitizedFilename);
                // Verify the resolved path is within the images directory (defense in depth)
                const resolvedPath = path.resolve(imagePath);
                const resolvedImagesDir = path.resolve(imagesDir);
                if (!resolvedPath.startsWith(resolvedImagesDir + path.sep)) {
                  console.warn('[TASK_REVIEW] Skipping image with path outside target directory:', image.filename);
                  continue;
                }
                writeFileSync(imagePath, imageBuffer);
                savedImages.push(`feedback_images/${sanitizedFilename}`);
                appLog.info('[TASK_REVIEW] Saved image:', sanitizedFilename);
              } catch (imgError) {
                console.error('[TASK_REVIEW] Failed to save image:', image.filename, imgError);
              }
            }
            if (savedImages.length > 0) {
              imageReferences = '\n\n## Reference Images\n\n' +
                savedImages.map(imgPath => `![Feedback Image](${imgPath})`).join('\n\n');
            }
          } catch (dirError) {
            console.error('[TASK_REVIEW] Failed to create images directory:', dirError);
          }
        }

        try {
          writeFileSync(
            fixRequestPath,
            `# QA Fix Request\n\nStatus: REJECTED\n\n## Feedback\n\n${feedback || 'No feedback provided'}${imageReferences}\n\nCreated at: ${new Date().toISOString()}\n`,
            'utf-8'
          );
        } catch (error) {
          console.error('[TASK_REVIEW] Failed to write QA fix request:', error);
          return { success: false, error: 'Failed to write QA fix request file' };
        }

        // Clear stale tracking state before starting new QA process
        taskStateManager.prepareForRestart(taskId);

        // Restart QA process - use worktree path if it exists, otherwise main project
        // The QA process needs to run where the implementation_plan.json with completed subtasks is
        const qaProjectPath = hasWorktree ? worktreePath : project.path;
        console.warn('[TASK_REVIEW] Starting QA process with projectPath:', qaProjectPath);
        agentManager.startQAProcess(taskId, qaProjectPath, task.specId, project.id);

        taskStateManager.handleUiEvent(
          taskId,
          { type: 'USER_RESUMED' },
          task,
          project
        );
      }

      return { success: true };
    }
  );

  /**
   * Update task status manually
   * Options:
   * - forceCleanup: When setting to 'done' with a worktree present, delete the worktree first
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_UPDATE_STATUS,
    async (
      _,
      taskId: string,
      status: TaskStatus,
      options?: { forceCleanup?: boolean; keepWorktree?: boolean }
    ): Promise<IPCResult & { worktreeExists?: boolean; worktreePath?: string }> =>
      applyTaskStatusUpdate(agentManager, getMainWindow, taskId, status, options)
  );

  /**
   * Check if a task is actually running (has active process)
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_CHECK_RUNNING,
    async (_, taskId: string): Promise<IPCResult<boolean>> => {
      const isRunning = agentManager.isRunning(taskId);
      return { success: true, data: isRunning };
    }
  );

  /**
   * Resume a paused task (rate limited or auth failure paused)
   * This writes a RESUME file to the spec directory to signal the backend to continue
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_RESUME_PAUSED,
    async (_, taskId: string): Promise<IPCResult> => {
      // Find task and project
      const { task, project } = findTaskAndProject(taskId);

      if (!task || !project) {
        return { success: false, error: 'Task not found' };
      }

      // Get the spec directory - use task.specsPath if available (handles worktree vs main)
      const specsBaseDir = getSpecsDir(project.autoBuildPath);
      const specDir = task.specsPath || path.join(
        project.path,
        specsBaseDir,
        task.specId
      );

      // Write RESUME file to signal backend to continue
      const resumeFilePath = path.join(specDir, 'RESUME');

      try {
        const resumeContent = JSON.stringify({
          resumed_at: new Date().toISOString(),
          resumed_by: 'user'
        });
        writeFileAtomicSync(resumeFilePath, resumeContent);
        appLog.info(`[TASK_RESUME_PAUSED] Wrote RESUME file to: ${resumeFilePath}`);

        // Also write to worktree if it exists (backend may be running inside the worktree)
        const worktreePath = findTaskWorktree(project.path, task.specId);
        if (worktreePath) {
          const worktreeResumeFilePath = path.join(worktreePath, specsBaseDir, task.specId, 'RESUME');
          try {
            writeFileAtomicSync(worktreeResumeFilePath, resumeContent);
            appLog.info(`[TASK_RESUME_PAUSED] Also wrote RESUME file to worktree: ${worktreeResumeFilePath}`);
          } catch (worktreeError) {
            // Non-fatal - main spec dir RESUME is sufficient
            console.warn(`[TASK_RESUME_PAUSED] Could not write to worktree (non-fatal):`, worktreeError);
          }
        } else if (
          task.executionProgress?.phase === 'rate_limit_paused' ||
          task.executionProgress?.phase === 'auth_failure_paused'
        ) {
          // Warn if worktree not found for a paused task - the backend is likely
          // running inside the worktree and may not see the RESUME file in the main spec dir
          console.warn(
            `[TASK_RESUME_PAUSED] Worktree not found for paused task ${task.specId}. ` +
            `Backend may not detect the RESUME file if running inside a worktree.`
          );
        }

        return { success: true };
      } catch (error) {
        console.error('[TASK_RESUME_PAUSED] Failed to write RESUME file:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to signal resume'
        };
      }
    }
  );

  /**
   * Recover a stuck task (status says in_progress but no process running)
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_RECOVER_STUCK,
    async (
      _,
      taskId: string,
      options?: { targetStatus?: TaskStatus; autoRestart?: boolean }
    ): Promise<IPCResult<{ taskId: string; recovered: boolean; newStatus: TaskStatus; message: string; autoRestarted?: boolean }>> => {
      const targetStatus = options?.targetStatus;
      const autoRestart = options?.autoRestart ?? false;
      // Check if task is actually running
      const isActuallyRunning = agentManager.isRunning(taskId);

      if (isActuallyRunning) {
        return {
          success: false,
          error: 'Task is still running. Stop it first before recovering.',
          data: {
            taskId,
            recovered: false,
            newStatus: 'in_progress' as TaskStatus,
            message: 'Task is still running'
          }
        };
      }

      // Find task and project
      const { task, project } = findTaskAndProject(taskId);

      if (!task || !project) {
        return { success: false, error: 'Task not found' };
      }

      // Get the spec directory - use task.specsPath if available (handles worktree vs main)
      // This is critical: task might exist in worktree, and getTasks() prefers worktree version.
      // If we write to main project but task is in worktree, the worktree's old status takes precedence on refresh.
      const specDir = task.specsPath || path.join(
        project.path,
        getSpecsDir(project.autoBuildPath),
        task.specId
      );

      // Update implementation_plan.json
      const planPath = path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
      appLog.info(`[Recovery] Writing to plan file at: ${planPath} (task location: ${task.location || 'main'})`);

      // Also update the OTHER location if task exists in both main and worktree
      // This ensures consistency regardless of which version getTasks() prefers
      const specsBaseDir = getSpecsDir(project.autoBuildPath);
      const mainSpecDir = path.join(project.path, specsBaseDir, task.specId);
      const worktreePath = findTaskWorktree(project.path, task.specId);
      const worktreeSpecDir = worktreePath ? path.join(worktreePath, specsBaseDir, task.specId) : null;

      // Collect all plan file paths that need updating
      const planPathsToUpdate: string[] = [planPath];
      if (mainSpecDir !== specDir && existsSync(path.join(mainSpecDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN))) {
        planPathsToUpdate.push(path.join(mainSpecDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN));
      }
      if (worktreeSpecDir && worktreeSpecDir !== specDir && existsSync(path.join(worktreeSpecDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN))) {
        planPathsToUpdate.push(path.join(worktreeSpecDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN));
      }
      appLog.info(`[Recovery] Will update ${planPathsToUpdate.length} plan file(s):`, planPathsToUpdate);

      try {
        // Read the plan to analyze subtask progress
        // Using safe read to avoid TOCTOU race conditions
        let plan: Record<string, unknown> | null = null;
        const planContent = safeReadFileSync(planPath);
        if (planContent) {
          try {
            plan = JSON.parse(planContent);
          } catch (parseError) {
            console.error('[Recovery] Failed to parse plan file as JSON:', parseError);
            return {
              success: false,
              error: 'Plan file contains invalid JSON. The file may be corrupted.'
            };
          }
        }

        // Determine the target status intelligently based on subtask progress
        // If targetStatus is explicitly provided, use it; otherwise calculate from subtasks
        let newStatus: TaskStatus = targetStatus || 'backlog';

        if (!targetStatus && plan?.phases && Array.isArray(plan.phases)) {
          // Analyze subtask statuses to determine appropriate recovery status
          const { completedCount, totalCount, allCompleted } = checkSubtasksCompletion(plan);

          if (totalCount > 0) {
            if (allCompleted) {
              // All subtasks completed - should go to review (ai_review or human_review based on source)
              // For recovery, human_review is safer as it requires manual verification
              newStatus = 'human_review';
            } else if (completedCount > 0) {
              // Some subtasks completed, some still pending - task is in progress
              newStatus = 'in_progress';
            }
            // else: no subtasks completed, stay with 'backlog'
          }
        }

        if (plan) {
          // Update status
          plan.status = newStatus;
          plan.planStatus = newStatus === 'done' ? 'completed'
            : newStatus === 'in_progress' ? 'in_progress'
            : newStatus === 'ai_review' ? 'review'
            : newStatus === 'human_review' ? 'review'
            : 'pending';
          plan.updated_at = new Date().toISOString();

          // Sync executionPhase and xstateState with the recovery status.
          // Without this, project-store.ts uses the stale executionPhase (which has
          // priority over xstateState) when loading tasks, causing the Kanban spinner
          // to persist even though the task status has been corrected.
          plan.xstateState = newStatus;
          if (newStatus === 'human_review' || newStatus === 'done') {
            plan.executionPhase = 'complete';
          } else if (newStatus === 'backlog') {
            plan.executionPhase = 'idle';
          } else if (newStatus === 'in_progress') {
            plan.executionPhase = 'coding';
          }

          // Add recovery note
          plan.recoveryNote = `Task recovered from stuck state at ${new Date().toISOString()}`;

          // Check if task is actually stuck or just completed and waiting for merge
          const { allCompleted } = checkSubtasksCompletion(plan);

          if (allCompleted) {
            appLog.info('[Recovery] Task is fully complete (all subtasks done), setting to human_review without restart');
            // Don't reset any subtasks - task is done!
            // Just update status in plan file (project store reads from file, no separate update needed)
            plan.status = 'human_review';
            plan.planStatus = 'review';
            plan.executionPhase = 'complete';
            plan.xstateState = 'human_review';

            // Write to ALL plan file locations to ensure consistency
            const planContent = JSON.stringify(plan, null, 2);
            let writeSucceededForComplete = false;
            for (const pathToUpdate of planPathsToUpdate) {
              try {
                writeFileAtomicSync(pathToUpdate, planContent);
                appLog.info(`[Recovery] Successfully wrote to: ${pathToUpdate}`);
                writeSucceededForComplete = true;
              } catch (writeError) {
                console.error(`[Recovery] Failed to write plan file at ${pathToUpdate}:`, writeError);
                // Continue trying other paths
              }
            }

            if (!writeSucceededForComplete) {
              return {
                success: false,
                error: 'Failed to write plan file during recovery (all locations failed)'
              };
            }

            // CRITICAL: Invalidate cache AFTER file writes complete
            // This ensures getTasks() returns fresh data reflecting the recovery
            projectStore.invalidateTasksCache(project.id);

            return {
              success: true,
              data: {
                taskId,
                recovered: true,
                newStatus: 'human_review',
                message: 'Task is complete and ready for review',
                autoRestarted: false
              }
            };
          }

          // Task is not complete - reset only stuck subtasks for retry
          // Keep completed subtasks as-is so run.py can resume from where it left off
          // Use shared utility to reset stuck subtasks in ALL plan file locations
          let totalResetCount = 0;
          let resetSucceeded = false;
          let resetFailedCount = 0;
          for (const pathToUpdate of planPathsToUpdate) {
            try {
              const resetResult = await resetStuckSubtasks(pathToUpdate, project.id);
              if (resetResult.success) {
                resetSucceeded = true;
                totalResetCount += resetResult.resetCount;
                if (resetResult.resetCount > 0) {
                  appLog.info(`[Recovery] Reset ${resetResult.resetCount} stuck subtask(s) in: ${pathToUpdate}`);
                }
              } else {
                resetFailedCount++;
              }
            } catch (resetError) {
              resetFailedCount++;
              console.error(`[Recovery] Failed to reset stuck subtasks at ${pathToUpdate}:`, resetError);
            }
          }

          if (!resetSucceeded) {
            return {
              success: false,
              error: 'Failed to reset stuck subtasks during recovery'
            };
          }

          if (resetFailedCount > 0) {
            console.warn(`[Recovery] Partial reset: ${totalResetCount} subtask(s) reset, but ${resetFailedCount} location(s) failed`);
          }

          appLog.info(`[Recovery] Total ${totalResetCount} subtask(s) reset across all locations`);

          // Clear attempt_history.json to break infinite recovery loops.
          // Without this, the backend re-reads stuck markers from attempt_history
          // and immediately re-stucks the same subtasks after recovery.
          const specDirsToClean = new Set<string>([specDir]);
          if (mainSpecDir !== specDir) specDirsToClean.add(mainSpecDir);
          if (worktreeSpecDir && worktreeSpecDir !== specDir) specDirsToClean.add(worktreeSpecDir);

          for (const dir of specDirsToClean) {
            const attemptHistoryPath = path.join(dir, 'memory', 'attempt_history.json');
            const historyContent = safeReadFileSync(attemptHistoryPath);
            if (!historyContent) continue;

            try {
              const history = JSON.parse(historyContent);

              // Collect stuck subtask IDs before clearing
              const stuckIds = new Set<string>(
                (history.stuck_subtasks || [])
                  .map((s: { subtask_id?: string }) => s.subtask_id)
                  .filter((id: string | undefined): id is string => Boolean(id))
              );

              // Clear stuck_subtasks array
              history.stuck_subtasks = [];

              // Reset attempt entries for previously-stuck subtasks
              if (history.subtasks && stuckIds.size > 0) {
                for (const stuckId of stuckIds) {
                  if (history.subtasks[stuckId]) {
                    history.subtasks[stuckId] = { attempts: [], status: 'pending' };
                  }
                }
              }

              history.metadata = {
                ...history.metadata,
                last_updated: new Date().toISOString()
              };

              writeFileAtomicSync(attemptHistoryPath, JSON.stringify(history, null, 2));
              appLog.info(`[Recovery] Cleared attempt_history.json at: ${dir} (reset ${stuckIds.size} stuck entries)`);
            } catch (historyErr) {
              console.warn(`[Recovery] Could not parse attempt_history at ${dir}:`, historyErr);
            }
          }
        }

        // Stop file watcher if it was watching this task
        fileWatcher.unwatch(taskId).catch((err) => {
          console.error('[TASK_RECOVER_STUCK] Failed to unwatch:', err);
        });

        // Auto-restart the task if requested
        let autoRestarted = false;
        if (autoRestart) {
          // Clear stale tracking state before restarting
          taskStateManager.prepareForRestart(taskId);
          const pre = await preflightTaskLaunch(task, project);
          if (!pre.ok) {
            console.warn('[Recovery] Preflight failed, cannot auto-restart task:', pre.error);
            // Recovery succeeded but we can't restart
            return {
              success: true,
              data: {
                taskId,
                recovered: true,
                newStatus,
                message: `Task recovered but cannot restart: ${pre.error}`,
                autoRestarted: false
              }
            };
          }


          try {
            // Cancel any pending fallback timer from previous process exit
            // This prevents the stale timer from incorrectly stopping the restarted task
            cancelFallbackTimer(taskId);

            // Set status to in_progress for the restart
            newStatus = 'in_progress';

            // Update plan status for restart - write to ALL locations
            if (plan) {
              plan.status = 'in_progress';
              plan.planStatus = 'in_progress';
              const restartPlanContent = JSON.stringify(plan, null, 2);
              for (const pathToUpdate of planPathsToUpdate) {
                try {
                  writeFileAtomicSync(pathToUpdate, restartPlanContent);
                  appLog.info(`[Recovery] Wrote restart status to: ${pathToUpdate}`);
                } catch (writeError) {
                  console.error(`[Recovery] Failed to write plan file for restart at ${pathToUpdate}:`, writeError);
                  // Continue with restart attempt even if file write fails
                  // The plan status will be updated by the agent when it starts
                }
              }

              // CRITICAL: Invalidate cache AFTER file writes complete
              // This ensures getTasks() returns fresh data reflecting the restart status
              projectStore.invalidateTasksCache(project.id);
            }

            launchTask({ task, project, agentManager, logTag: '[Recovery]' });

            autoRestarted = true;
            console.warn(`[Recovery] Auto-restarted task ${taskId}`);
          } catch (restartError) {
            console.error('Failed to auto-restart task after recovery:', restartError);
            // Recovery succeeded but restart failed - still report success
          }
        }

        // Notify renderer of status change
        const mainWindow = getMainWindow();
        if (mainWindow) {
          mainWindow.webContents.send(
            IPC_CHANNELS.TASK_STATUS_CHANGE,
            taskId,
            newStatus,
            project.id
          );
        }

        // zeenha fork: a recovered task may have left in_progress and freed a slot
        void taskQueueManager.onTaskStatusChanged(taskId, newStatus, project.id);

        return {
          success: true,
          data: {
            taskId,
            recovered: true,
            newStatus,
            message: autoRestarted
              ? 'Task recovered and restarted successfully'
              : `Task recovered successfully and moved to ${newStatus}`,
            autoRestarted
          }
        };
      } catch (error) {
        console.error('Failed to recover stuck task:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to recover task'
        };
      }
    }
  );
}

/**
 * Stop a task. Shared by the TASK_STOP IPC handler and the scheduler.
 */
export function stopTask(agentManager: AgentManager, taskId: string): void {
  agentManager.killTask(taskId);
  fileWatcher.unwatch(taskId).catch((err) => {
    console.error('[TASK_STOP] Failed to unwatch:', err);
  });

  // Find task and project to emit USER_STOPPED with plan context
  const { task, project } = findTaskAndProject(taskId);

  if (!task || !project) return;

  // Use shared utility to determine if a valid implementation plan exists
  const hasPlan = hasPlanWithSubtasks(project, task);

  taskStateManager.handleUiEvent(
    taskId,
    { type: 'USER_STOPPED', hasPlan },
    task,
    project
  );

  // Clear stale tracking state so a subsequent restart works correctly
  taskStateManager.prepareForRestart(taskId);
}
