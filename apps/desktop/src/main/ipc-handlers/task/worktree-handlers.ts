import { ipcMain, BrowserWindow } from 'electron';
import { IPC_CHANNELS, AUTO_BUILD_PATHS, getSpecsDir } from '../../../shared/constants';
import type { IPCResult, WorktreeStatus, WorktreeDiff, WorktreeDiffFile, WorktreeMergeResult, WorktreeDiscardResult, WorktreeListResult, WorktreeListItem, WorktreeCreatePROptions, WorktreeCreatePRResult, WorktreeCreatePRErrorCode } from '../../../shared/types';
import path from 'path';
import { existsSync, statSync, readFileSync, realpathSync, promises as fsPromises } from 'fs';
import { execFileSync, execFile } from 'child_process';
import { projectStore } from '../../project-store';

import { MergeOrchestrator } from '../../ai/merge/orchestrator';
import { createPR, createMR, suggestPRTitleForWorktree } from '../../ai/runners/github/pr-creator';
import { capPRTitle } from '../../../shared/utils/pr-title';
import { findTaskAndProject } from './shared';
import { updateRoadmapFeatureOutcome } from '../../utils/roadmap-utils';
import { getToolPath } from '../../cli-tool-manager';
import { promisify } from 'util';
import {
  getTaskWorktreeDir,
  findTaskWorktree,
} from '../../worktree-paths';
import { updateTaskStatusAfterPRCreation, originMatchesInstance, MAX_PR_TITLE_LENGTH, PRINTABLE_CHARS_REGEX } from './worktree-pr';
import { getGitLabConfig } from '../gitlab/utils';
import { refreshGitIndex } from '../../utils/git-isolation';
import { cleanupWorktree } from '../../utils/worktree-cleanup';
import { taskStateManager } from '../../task-state-manager';
import { handleWorktreeMerge } from './worktree-merge';
import { isGitWorkTree, getTaskBaseBranch, getEffectiveBaseBranch, GIT_BRANCH_REGEX } from './worktree-git-utils';

export { GIT_BRANCH_REGEX } from './worktree-git-utils';

/**
 * Validates a detected branch name and returns the safe branch to delete.
 *
 * Why `auto-claude/` prefix is considered safe:
 * - All task worktrees use branches named `auto-claude/{specId}`
 * - This pattern is controlled by Auto-Claude, not user input
 * - If detected branch matches this pattern, it's a valid task branch
 * - If it doesn't match (e.g., `main`, `develop`, `feature/xxx`), it's likely
 *   the main project's branch being incorrectly detected from a corrupted worktree
 *
 * Issue #1479: When cleaning up a corrupted worktree, git rev-parse walks up
 * to the main project and returns its current branch instead of the worktree's branch.
 * This could cause deletion of the wrong branch.
 */
export function validateWorktreeBranch(
  detectedBranch: string | null,
  expectedBranch: string
): { branchToDelete: string; usedFallback: boolean; reason: string } {
  // If detection failed, use expected pattern
  if (detectedBranch === null) {
    return {
      branchToDelete: expectedBranch,
      usedFallback: true,
      reason: 'detection_failed',
    };
  }

  // Exact match - ideal case
  if (detectedBranch === expectedBranch) {
    return {
      branchToDelete: detectedBranch,
      usedFallback: false,
      reason: 'exact_match',
    };
  }

  // Matches auto-claude pattern with valid specId (not just "auto-claude/")
  // The specId must be non-empty for this to be a valid task branch
  if (detectedBranch.startsWith('auto-claude/') && detectedBranch.length > 'auto-claude/'.length) {
    return {
      branchToDelete: detectedBranch,
      usedFallback: false,
      reason: 'pattern_match',
    };
  }

  // Detected branch doesn't match expected pattern - use fallback
  // This is the critical security fix for issue #1479
  return {
    branchToDelete: expectedBranch,
    usedFallback: true,
    reason: 'invalid_pattern',
  };
}

/**
 * zeenha fork: subtask counts from the first readable implementation_plan.json
 * among `specDirs` (the worktree's copy first: the coder updates that one).
 * Undefined when no plan has subtasks.
 */
export function readSubtaskProgress(specDirs: string[]): { completed: number; total: number } | undefined {
  for (const dir of specDirs) {
    try {
      const plan = JSON.parse(readFileSync(path.join(dir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN), 'utf-8'));
      const subtasks = (Array.isArray(plan?.phases) ? plan.phases : []).flatMap(
        (phase: { subtasks?: unknown }) => (Array.isArray(phase?.subtasks) ? phase.subtasks : [])
      ) as Array<{ status?: unknown }>;
      if (subtasks.length === 0) continue;
      return { completed: subtasks.filter((s) => s?.status === 'completed').length, total: subtasks.length };
    } catch {
      // missing or unreadable: try the next copy
    }
  }
  return undefined;
}


/**
 * Register worktree management handlers
 */
export function registerWorktreeHandlers(
  getMainWindow: () => BrowserWindow | null
): void {
  /**
   * Get the worktree status for a task
   * Per-spec architecture: Each spec has its own worktree at .auto-claude/worktrees/tasks/{spec-name}/
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_WORKTREE_STATUS,
    async (_, taskId: string): Promise<IPCResult<WorktreeStatus>> => {
      try {
        const { task, project } = findTaskAndProject(taskId);
        if (!task || !project) {
          return { success: false, error: 'Task not found' };
        }

        // Find worktree at .auto-claude/worktrees/tasks/{spec-name}/
        const worktreePath = findTaskWorktree(project.path, task.specId);

        if (!worktreePath) {
          return {
            success: true,
            data: { exists: false }
          };
        }

        // Get branch info from git
        try {
          // Get current branch in worktree
          const branch = execFileSync(getToolPath('git'), ['rev-parse', '--abbrev-ref', 'HEAD'], {
            cwd: worktreePath,
            encoding: 'utf-8'
          }).trim();

          // Get base branch using proper fallback chain:
          // 1. Task metadata baseBranch, 2. Project settings mainBranch, 3. main/master detection
          const baseBranch = getEffectiveBaseBranch(project.path, task.specId, project.settings?.mainBranch);

          // Get user's current branch in main project (this is where changes will merge INTO)
          let currentProjectBranch: string | undefined;
          try {
            currentProjectBranch = execFileSync(getToolPath('git'), ['rev-parse', '--abbrev-ref', 'HEAD'], {
              cwd: project.path,
              encoding: 'utf-8'
            }).trim();
          } catch {
            // Ignore - might be in detached HEAD or git error
          }

          // Get commit count (cross-platform - no shell syntax)
          let commitCount = 0;
          try {
            const countOutput = execFileSync(getToolPath('git'), ['rev-list', '--count', `${baseBranch}..HEAD`], {
              cwd: worktreePath,
              encoding: 'utf-8',
              stdio: ['pipe', 'pipe', 'pipe']
            }).trim();
            commitCount = parseInt(countOutput, 10) || 0;
          } catch {
            commitCount = 0;
          }

          // Get diff stats
          let filesChanged = 0;
          let additions = 0;
          let deletions = 0;

          // Use working-tree diff against baseBranch to capture ALL changes
          // (both committed and uncommitted). This ensures the UI shows file stats
          // even when the agent hasn't committed its work yet.
          try {
            const diffStat = execFileSync(getToolPath('git'), ['diff', '--stat', baseBranch], {
              cwd: worktreePath,
              encoding: 'utf-8',
              stdio: ['pipe', 'pipe', 'pipe']
            }).trim();

            // Parse the summary line (e.g., "3 files changed, 50 insertions(+), 10 deletions(-)")
            const summaryMatch = diffStat.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
            if (summaryMatch) {
              filesChanged = parseInt(summaryMatch[1], 10) || 0;
              additions = parseInt(summaryMatch[2], 10) || 0;
              deletions = parseInt(summaryMatch[3], 10) || 0;
            }
          } catch {
            // Ignore diff errors
          }

          return {
            success: true,
            data: {
              exists: true,
              worktreePath,
              branch,
              baseBranch,
              currentProjectBranch,
              commitCount,
              filesChanged,
              additions,
              deletions
            }
          };
        } catch (gitError) {
          console.error('Git error getting worktree status:', gitError);
          return {
            success: true,
            data: { exists: true, worktreePath }
          };
        }
      } catch (error) {
        console.error('Failed to get worktree status:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get worktree status'
        };
      }
    }
  );

  /**
   * Get the diff for a task's worktree
   * Per-spec architecture: Each spec has its own worktree at .auto-claude/worktrees/tasks/{spec-name}/
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_WORKTREE_DIFF,
    async (_, taskId: string): Promise<IPCResult<WorktreeDiff>> => {
      try {
        const { task, project } = findTaskAndProject(taskId);
        if (!task || !project) {
          return { success: false, error: 'Task not found' };
        }

        // Find worktree at .auto-claude/worktrees/tasks/{spec-name}/
        const worktreePath = findTaskWorktree(project.path, task.specId);

        if (!worktreePath) {
          return { success: false, error: 'No worktree found for this task' };
        }

        // Get base branch using proper fallback chain:
        // 1. Task metadata baseBranch, 2. Project settings mainBranch, 3. main/master detection
        // Note: We do NOT use current HEAD as that may be a feature branch
        const baseBranch = getEffectiveBaseBranch(project.path, task.specId, project.settings?.mainBranch);

        // Get the diff with file stats
        const files: WorktreeDiffFile[] = [];

        let numstat = '';
        let nameStatus = '';
        try {
          // Use working-tree diff against baseBranch to capture ALL changes
          // (both committed and uncommitted). This ensures the diff view shows
          // file changes even when the agent hasn't committed its work yet.
          numstat = execFileSync(getToolPath('git'), ['diff', '--numstat', baseBranch], {
            cwd: worktreePath,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe']
          }).trim();

          // Get name-status for file status (cross-platform)
          nameStatus = execFileSync(getToolPath('git'), ['diff', '--name-status', baseBranch], {
            cwd: worktreePath,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe']
          }).trim();

          // Parse name-status to get file statuses
          const statusMap: Record<string, 'added' | 'modified' | 'deleted' | 'renamed'> = {};
          nameStatus.split('\n').filter(Boolean).forEach((line: string) => {
            const [status, ...pathParts] = line.split('\t');
            const filePath = pathParts.join('\t'); // Handle files with tabs in name
            switch (status[0]) {
              case 'A': statusMap[filePath] = 'added'; break;
              case 'M': statusMap[filePath] = 'modified'; break;
              case 'D': statusMap[filePath] = 'deleted'; break;
              case 'R': statusMap[pathParts[1] || filePath] = 'renamed'; break;
              default: statusMap[filePath] = 'modified';
            }
          });

          // Parse numstat for additions/deletions
          numstat.split('\n').filter(Boolean).forEach((line: string) => {
            const [adds, dels, filePath] = line.split('\t');
            files.push({
              path: filePath,
              status: statusMap[filePath] || 'modified',
              additions: parseInt(adds, 10) || 0,
              deletions: parseInt(dels, 10) || 0
            });
          });
        } catch (diffError) {
          console.error('Error getting diff:', diffError);
        }

        // Generate summary
        const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
        const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);
        const summary = `${files.length} files changed, ${totalAdditions} insertions(+), ${totalDeletions} deletions(-)`;

        return {
          success: true,
          data: { files, summary }
        };
      } catch (error) {
        console.error('Failed to get worktree diff:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get worktree diff'
        };
      }
    }
  );

  /**
   * Merge the worktree changes into the main branch
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_WORKTREE_MERGE,
    async (_, taskId: string, options?: { noCommit?: boolean }): Promise<IPCResult<WorktreeMergeResult>> =>
      handleWorktreeMerge(getMainWindow, taskId, options)
  );

  /**
   * Preview merge conflicts before actually merging
   * Uses the TypeScript MergeOrchestrator to analyze potential conflicts without applying changes
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_WORKTREE_MERGE_PREVIEW,
    async (_, taskId: string): Promise<IPCResult<WorktreeMergeResult>> => {
      console.warn('[IPC] TASK_WORKTREE_MERGE_PREVIEW called with taskId:', taskId);
      try {
        const { task, project } = findTaskAndProject(taskId);
        if (!task || !project) {
          console.error('[IPC] Task not found:', taskId);
          return { success: false, error: 'Task not found' };
        }
        console.warn('[IPC] Found task:', task.specId, 'project:', project.name);

        // Check for uncommitted changes in the main project (only if not a bare repo)
        let hasUncommittedChanges = false;
        let uncommittedFiles: string[] = [];
        if (isGitWorkTree(project.path)) {
          try {
            refreshGitIndex(project.path);

            const gitStatus = execFileSync(getToolPath('git'), ['status', '--porcelain'], {
              cwd: project.path,
              encoding: 'utf-8'
            });

            if (gitStatus?.trim()) {
              // Parse the status output to get file names
              // Format: XY filename (where X and Y are status chars, then space, then filename)
              uncommittedFiles = gitStatus
                .split('\n')
                .filter(line => line.trim())
                .map(line => line.substring(3).trim()) // Skip 2 status chars + 1 space, trim any trailing whitespace
                .filter(file => file); // Remove empty strings from short/malformed status lines

              hasUncommittedChanges = uncommittedFiles.length > 0;
            }
          } catch (e) {
            console.error('[IPC] Failed to check git status:', e);
          }
        } else {
          console.warn('[IPC] Project is a bare repository - skipping uncommitted changes check');
        }

        // Determine base branch with proper priority:
        // 1. Task metadata baseBranch (explicit task-level override)
        // 2. Project settings mainBranch (project-level default)
        // 3. Default to 'main'
        const specDir = path.join(project.path, project.autoBuildPath || '.auto-claude', 'specs', task.specId);
        const taskBaseBranch = getTaskBaseBranch(specDir);
        const projectMainBranch = project.settings?.mainBranch;
        const effectiveBaseBranch = taskBaseBranch || projectMainBranch || 'main';
        console.warn('[IPC] Using base branch for preview:', effectiveBaseBranch,
          `(source: ${taskBaseBranch ? 'task metadata' : projectMainBranch ? 'project settings' : 'default'})`);

        // Run preview using the TypeScript MergeOrchestrator in dry-run mode
        // (no AI resolver needed for preview — only conflict detection and analysis)
        const storageDir = path.join(project.path, project.autoBuildPath || '.auto-claude');
        const orchestrator = new MergeOrchestrator({
          projectDir: project.path,
          storageDir,
          enableAi: false,
          dryRun: true,
        });

        // Refresh evolution data from git before previewing.
        // previewMerge() only reads from the in-memory evolutions map (loaded from file_evolution.json).
        // Without refreshFromGit(), the map is stale/empty for tasks whose evolution wasn't previously tracked.
        const worktreePath = findTaskWorktree(project.path, task.specId);
        if (worktreePath) {
          console.warn('[IPC] Refreshing evolution data from worktree:', worktreePath);
          await orchestrator.evolutionTracker.refreshFromGit(task.specId, worktreePath, effectiveBaseBranch);
        } else {
          console.warn('[IPC] No worktree found for preview — evolution data may be stale');
        }

        console.warn('[IPC] Running TypeScript merge preview for task:', task.specId);
        const previewResult = orchestrator.previewMerge([task.specId]);

        const summary = previewResult['summary'] as Record<string, number> | undefined;
        const rawConflicts = previewResult['conflicts'] as Array<Record<string, unknown>> | undefined;
        const filesToMerge = previewResult['files_to_merge'] as string[] | undefined;

        // Map orchestrator conflict format to frontend MergeConflict shape
        const mergeConflicts = (rawConflicts || []).map((c) => ({
          file: String(c['file'] ?? ''),
          location: String(c['location'] ?? ''),
          tasks: Array.isArray(c['tasks']) ? (c['tasks'] as string[]) : [],
          severity: (c['severity'] ?? 'low') as import('../../../shared/types/task').ConflictSeverity,
          canAutoMerge: Boolean(c['can_auto_merge']),
          strategy: c['strategy'] != null ? String(c['strategy']) : undefined,
          reason: String(c['reason'] ?? ''),
        }));

        return {
          success: true,
          data: {
            success: true,
            message: 'Preview completed',
            preview: {
              files: filesToMerge || [],
              conflicts: mergeConflicts,
              summary: {
                totalFiles: summary?.['total_files'] ?? 0,
                conflictFiles: summary?.['conflict_files'] ?? 0,
                totalConflicts: summary?.['total_conflicts'] ?? 0,
                autoMergeable: summary?.['auto_mergeable'] ?? 0,
                hasGitConflicts: false,
              },
              // Include uncommitted changes info for the frontend
              uncommittedChanges: hasUncommittedChanges ? {
                hasChanges: true,
                files: uncommittedFiles,
                count: uncommittedFiles.length,
              } : null,
            },
          },
        };
      } catch (error) {
        console.error('[IPC] TASK_WORKTREE_MERGE_PREVIEW error:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to preview merge'
        };
      }
    }
  );

  /**
   * Discard the worktree changes
   * Per-spec architecture: Each spec has its own worktree at .auto-claude/worktrees/tasks/{spec-name}/
   *
   * Note: Uses the shared cleanupWorktree utility which handles Windows-specific issues
   * where `git worktree remove --force` fails when the directory contains untracked files.
   * See: https://github.com/AndyMik90/Auto-Claude/issues/1539
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_WORKTREE_DISCARD,
    async (_, taskId: string, skipStatusChange?: boolean): Promise<IPCResult<WorktreeDiscardResult>> => {
      try {
        const { task, project } = findTaskAndProject(taskId);
        if (!task || !project) {
          return { success: false, error: 'Task not found' };
        }

        // Find worktree at .auto-claude/worktrees/tasks/{spec-name}/
        const worktreePath = findTaskWorktree(project.path, task.specId);

        if (!worktreePath) {
          return {
            success: true,
            data: {
              success: true,
              message: 'No worktree to discard'
            }
          };
        }

        // Use the shared cleanup utility for robust, cross-platform worktree deletion
        const cleanupResult = await cleanupWorktree({
          worktreePath,
          projectPath: project.path,
          specId: task.specId,
          logPrefix: '[TASK_WORKTREE_DISCARD]',
          deleteBranch: true
        });

        if (!cleanupResult.success) {
          console.error('[TASK_WORKTREE_DISCARD] Cleanup failed:', cleanupResult.warnings);
          return {
            success: false,
            error: `Failed to discard worktree: ${cleanupResult.warnings.join('; ')}`
          };
        }

        // Log any non-fatal warnings
        if (cleanupResult.warnings.length > 0) {
          console.warn('[TASK_WORKTREE_DISCARD] Cleanup warnings:', cleanupResult.warnings);
        }


        // Only send status change to backlog if not skipped
        // (skip when caller will set a different status, e.g., 'done')
        if (!skipStatusChange) {
          // Route through TaskStateManager (XState) to avoid dual emission
          taskStateManager.handleManualStatusChange(taskId, 'backlog', task, project);
        }

        return {
          success: true,
          data: {
            success: true,
            message: 'Worktree discarded successfully'
          }
        };
      } catch (error) {
        console.error('Failed to discard worktree:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to discard worktree'
        };
      }
    }
  );

  // Promisified execFile for async git operations
  const execFileAsync = promisify(execFile);

  /**
   * Discard an orphaned worktree by spec name (no task association required)
   * Used when the worktree exists but the task is missing or git state is corrupted
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_WORKTREE_DISCARD_ORPHAN,
    async (_, projectId: string, specName: string): Promise<IPCResult<WorktreeDiscardResult>> => {
      try {
        // Validate inputs
        if (!projectId || typeof projectId !== 'string') {
          console.error('discardOrphanedWorktree: Invalid projectId:', projectId);
          return { success: false, error: 'Invalid projectId' };
        }
        if (!specName || typeof specName !== 'string') {
          console.error('discardOrphanedWorktree: Invalid specName:', specName);
          return { success: false, error: 'Invalid specName' };
        }

        const project = projectStore.getProject(projectId);
        if (!project) {
          return { success: false, error: 'Project not found' };
        }

        // Validate project.path
        if (!project.path || typeof project.path !== 'string') {
          console.error('discardOrphanedWorktree: Project path is invalid:', project.path);
          return { success: false, error: 'Project path is invalid' };
        }

        // Find worktree at .auto-claude/worktrees/tasks/{spec-name}/
        const worktreePath = findTaskWorktree(project.path, specName);

        if (!worktreePath) {
          return {
            success: true,
            data: {
              success: true,
              message: 'No worktree to discard'
            }
          };
        }

        // Use cleanupWorktree for robust, cross-platform worktree deletion
        const cleanupResult = await cleanupWorktree({
          worktreePath,
          projectPath: project.path,
          specId: specName,
          logPrefix: '[ORPHAN_CLEANUP]',
          deleteBranch: true
        });

        if (!cleanupResult.success) {
          return {
            success: false,
            error: cleanupResult.warnings.join(', ') || 'Failed to cleanup orphaned worktree'
          };
        }

        return {
          success: true,
          data: {
            success: true,
            message: 'Orphaned worktree deleted successfully'
          }
        };
      } catch (error) {
        console.error('Failed to discard orphaned worktree:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to discard orphaned worktree'
        };
      }
    }
  );

  /**
   * List all spec worktrees for a project
   * Per-spec architecture: Each spec has its own worktree at .auto-claude/worktrees/tasks/{spec-name}/
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_LIST_WORKTREES,
    async (_, projectId: string): Promise<IPCResult<WorktreeListResult>> => {
      try {
        // Validate projectId
        if (!projectId || typeof projectId !== 'string') {
          console.error('listWorktrees: Invalid projectId:', projectId);
          return { success: false, error: 'Invalid projectId' };
        }

        const project = projectStore.getProject(projectId);
        if (!project) {
          return { success: false, error: 'Project not found' };
        }

// Validate project.path
        if (!project.path || typeof project.path !== 'string') {
          console.error('listWorktrees: Project path is invalid:', project.path);
          return { success: false, error: 'Project path is invalid' };
        }

        const worktreesDir = getTaskWorktreeDir(project.path);

        // Fetch tasks once before iterating (avoids repeated lookups per entry)
        // Used for orphan detection - worktrees without a matching task are orphaned
        const tasks = projectStore.getTasks(projectId);
        // Track if task lookup was successful (empty array with existing specs dir = lookup failed)
        const mainSpecsDir = path.join(project.path, '.auto-claude', 'specs');
        const taskLookupSuccessful = tasks.length > 0 || !existsSync(mainSpecsDir);

        // Helper to process a single worktree entry (async)
        const processWorktreeEntry = async (entry: string, entryPath: string): Promise<WorktreeListItem | null> => {
          try {
            // zeenha fork: a folder whose .git link is gone is not a worktree; git
            // inside it would report the PARENT repository (branch "main", its
            // stats). Send it down the broken-worktree path below instead.
            const topLevel = await execFileAsync(getToolPath('git'), ['rev-parse', '--show-toplevel'], {
              cwd: entryPath,
              encoding: 'utf-8'
            });
            if (realpathSync((topLevel.stdout as string).trim()) !== realpathSync(entryPath)) {
              throw new Error('not a git worktree (leftover folder)');
            }

            // Get branch info (async)
            const branchResult = await execFileAsync(getToolPath('git'), ['rev-parse', '--abbrev-ref', 'HEAD'], {
              cwd: entryPath,
              encoding: 'utf-8'
            });
            const branch = (branchResult.stdout as string).trim();

            // Get base branch using proper fallback chain:
            // 1. Task metadata baseBranch, 2. Project settings mainBranch, 3. main/master detection
            // Note: We do NOT use current HEAD as that may be a feature branch
            const baseBranch = getEffectiveBaseBranch(project.path, entry, project.settings?.mainBranch);

// Get commit count (async, cross-platform - no shell syntax)
            let commitCount = 0;
            try {
              const countResult = await execFileAsync(getToolPath('git'), ['rev-list', '--count', `${baseBranch}..HEAD`], {
                cwd: entryPath,
                encoding: 'utf-8'
              });
              commitCount = parseInt((countResult.stdout as string).trim(), 10) || 0;
            } catch {
              commitCount = 0;
            }

            // Get diff stats (async, cross-platform - no shell syntax)
            let filesChanged = 0;
            let additions = 0;
            let deletions = 0;

            try {
              const diffResult = await execFileAsync(getToolPath('git'), ['diff', '--shortstat', `${baseBranch}...HEAD`], {
                cwd: entryPath,
                encoding: 'utf-8'
              });
              const diffStat = (diffResult.stdout as string).trim();

              const filesMatch = diffStat.match(/(\d+) files? changed/);
              const addMatch = diffStat.match(/(\d+) insertions?/);
              const delMatch = diffStat.match(/(\d+) deletions?/);

              if (filesMatch) filesChanged = parseInt(filesMatch[1], 10) || 0;
              if (addMatch) additions = parseInt(addMatch[1], 10) || 0;
              if (delMatch) deletions = parseInt(delMatch[1], 10) || 0;
            } catch {
              // Ignore diff errors
            }

            // Check if there's a task associated with this worktree
            // A worktree without a task is considered orphaned (can happen if task was deleted)
            // Only mark as orphaned if task lookup was successful (avoid false positives)
            const hasTask = tasks.some(t => t.specId === entry);

            return {
              specName: entry,
              path: entryPath,
              branch,
              baseBranch,
              commitCount,
              filesChanged,
              additions,
              deletions,
              isOrphaned: taskLookupSuccessful ? !hasTask : false
            };
          } catch (gitError) {
            // FIX: Don't skip worktree if git fails - it may be orphaned/corrupted
            // Include it so it can be managed (deleted if orphaned)
            const hasTask = tasks.some(t => t.specId === entry);
            console.warn(`[Worktree] Git commands failed for ${entry}, hasTask=${hasTask}:`, gitError);
            // Note: branch is empty - renderer should handle based on isOrphaned flag
            return {
              specName: entry,
              path: entryPath,
              branch: '',
              baseBranch: '',
              commitCount: 0,
              filesChanged: 0,
              additions: 0,
              deletions: 0,
              isOrphaned: taskLookupSuccessful ? !hasTask : false
            };
          }
        };

        // Scan worktrees directory (async)
        if (!existsSync(worktreesDir)) {
          return { success: true, data: { worktrees: [] } };
        }

        const entries = await fsPromises.readdir(worktreesDir);

        // Process all worktrees in parallel for better performance
        const worktreePromises = entries.map(async (entry) => {
          const entryPath = path.join(worktreesDir, entry);
          try {
            const stat = await fsPromises.stat(entryPath);
            if (stat.isDirectory()) {
              return processWorktreeEntry(entry, entryPath);
            }
          } catch {
            // Skip entries that can't be stat'd
          }
          return null;
        });

        const results = await Promise.all(worktreePromises);
        const worktrees = results.filter((w): w is WorktreeListItem => w !== null);

        return { success: true, data: { worktrees } };
      } catch (error) {
        console.error('Failed to list worktrees:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to list worktrees'
        };
      }
    }
  );

  // Tool detection/launch handlers (detect tools, open in IDE/terminal) live in tool-handlers.ts

  /**
   * Clear the staged state for a task
   * This allows the user to re-stage changes if needed
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_CLEAR_STAGED_STATE,
    async (_, taskId: string): Promise<IPCResult<{ cleared: boolean }>> => {
      try {
        const { task, project } = findTaskAndProject(taskId);
        if (!task || !project) {
          return { success: false, error: 'Task not found' };
        }

        const specsBaseDir = getSpecsDir(project.autoBuildPath);
        const specDir = path.join(project.path, specsBaseDir, task.specId);
        const planPath = path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);

        // Use EAFP pattern (try/catch) instead of LBYL (existsSync check) to avoid TOCTOU race conditions
        const { promises: fsPromises } = require('fs');
        const isFileNotFound = (err: unknown): boolean =>
          !!(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT');

        // Read, update, and write the plan file
        let planContent: string;
        try {
          planContent = await fsPromises.readFile(planPath, 'utf-8');
        } catch (readErr) {
          if (isFileNotFound(readErr)) {
            return { success: false, error: 'Implementation plan not found' };
          }
          throw readErr;
        }

        const plan = JSON.parse(planContent);

        // Clear the staged state flags
        delete plan.stagedInMainProject;
        delete plan.stagedAt;
        plan.updated_at = new Date().toISOString();

        await fsPromises.writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8');

        // Also update worktree plan if it exists
        const worktreePath = findTaskWorktree(project.path, task.specId);
        if (worktreePath) {
          const worktreePlanPath = path.join(worktreePath, specsBaseDir, task.specId, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
          try {
            const worktreePlanContent = await fsPromises.readFile(worktreePlanPath, 'utf-8');
            const worktreePlan = JSON.parse(worktreePlanContent);
            delete worktreePlan.stagedInMainProject;
            delete worktreePlan.stagedAt;
            worktreePlan.updated_at = new Date().toISOString();
            await fsPromises.writeFile(worktreePlanPath, JSON.stringify(worktreePlan, null, 2), 'utf-8');
          } catch (e) {
            // Non-fatal - worktree plan update is best-effort
            // ENOENT is expected when worktree has no plan file
            if (!isFileNotFound(e)) {
              console.warn('[CLEAR_STAGED_STATE] Failed to update worktree plan:', e);
            }
          }
        }

        // Invalidate tasks cache to force reload
        projectStore.invalidateTasksCache(project.id);

        return { success: true, data: { cleared: true } };
      } catch (error) {
        console.error('Failed to clear staged state:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to clear staged state'
        };
      }
    }
  );

  /**
   * zeenha fork: suggest a short Conventional Commits PR title for a task, from
   * its task title, commit log, diff summary and any work the coder left
   * uncommitted. Read-only: it never stages or commits (Create PR commits that
   * work only once the person confirms). Answers null (and the dialog keeps
   * the task title) when there is no worktree or the model's answer is not a
   * usable title.
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_WORKTREE_SUGGEST_PR_TITLE,
    async (_, taskId: string, targetBranch?: string): Promise<IPCResult<string | null>> => {
      try {
        const { task, project } = findTaskAndProject(taskId);
        if (!task || !project) return { success: false, error: 'Task not found' };
        if (targetBranch && !GIT_BRANCH_REGEX.test(targetBranch)) {
          return { success: false, error: 'Invalid target branch name' };
        }

        const worktreePath = findTaskWorktree(project.path, task.specId);
        if (!worktreePath) return { success: true, data: null };

        const specDir = path.join(project.path, project.autoBuildPath || '.auto-claude', 'specs', task.specId);
        const baseBranch = targetBranch || getTaskBaseBranch(specDir) || project.settings?.mainBranch || 'main';

        const title = await suggestPRTitleForWorktree({
          worktreePath,
          gitPath: getToolPath('git'),
          baseBranch,
          taskTitle: task.title,
          specId: task.specId,
        });
        return { success: true, data: title };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Could not suggest a title' };
      }
    }
  );

  /**
   * Create a Pull Request from the worktree branch
   * Pushes the branch to origin and creates a GitHub PR using gh CLI,
   * or a GitLab merge request when the project's GitLab instance is its origin
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_WORKTREE_CREATE_PR,
    async (_, taskId: string, options?: WorktreeCreatePROptions): Promise<IPCResult<WorktreeCreatePRResult>> => {
      const isDebugMode = process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development';
      const debug = (...args: unknown[]) => {
        if (isDebugMode) {
          console.warn('[CREATE_PR DEBUG]', ...args);
        }
      };

      // zeenha fork: top-level success/error stay as before; the code rides in
      // data so callers need not match on the message text.
      const fail = (errorCode: WorktreeCreatePRErrorCode, error: string): IPCResult<WorktreeCreatePRResult> => ({
        success: false,
        error,
        data: { success: false, error, errorCode }
      });

      try {
        debug('Handler called with taskId:', taskId, 'options:', options);

        const { task, project } = findTaskAndProject(taskId);
        if (!task || !project) {
          debug('Task or project not found');
          return fail('TASK_NOT_FOUND', 'Task not found');
        }

        debug('Found task:', task.specId, 'project:', project.path);

        const specDir = path.join(project.path, project.autoBuildPath || '.auto-claude', 'specs', task.specId);

        // Use EAFP pattern - try to read specDir and catch ENOENT
        try {
          statSync(specDir);
        } catch (err) {
          if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
            debug('Spec directory not found:', specDir);
            return fail('SPEC_DIR_NOT_FOUND', 'Spec directory not found');
          }
          throw err; // Re-throw unexpected errors
        }

        // Check worktree exists before creating PR
        const worktreePath = findTaskWorktree(project.path, task.specId);
        if (!worktreePath) {
          debug('No worktree found for spec:', task.specId);
          return fail('NO_WORKTREE', 'No worktree found for this task');
        }
        debug('Worktree path:', worktreePath);

        // Validate options
        if (options?.targetBranch && !GIT_BRANCH_REGEX.test(options.targetBranch)) {
          return fail('INVALID_TARGET_BRANCH', 'Invalid target branch name');
        }
        if (options?.title) {
          if (options.title.length > MAX_PR_TITLE_LENGTH) {
            return fail('INVALID_TITLE_LENGTH', `PR title exceeds maximum length of ${MAX_PR_TITLE_LENGTH} characters`);
          }
          if (!PRINTABLE_CHARS_REGEX.test(options.title)) {
            return fail('INVALID_TITLE_CHARS', 'PR title contains invalid characters');
          }
        }

        // Determine base branch and branch name
        const taskBaseBranch = getTaskBaseBranch(specDir);
        const baseBranch = options?.targetBranch || taskBaseBranch || project.settings?.mainBranch || 'main';
        const branchName = `auto-claude/${task.specId}`;
        // zeenha fork: no title sent (the bulk dialog) -> createPR asks the model
        // once the pending work is committed, then falls back to the task title.
        // It used to be `auto-claude: <specId>`.
        const typedTitle = options?.title || undefined;
        // The task title is often the spec's whole first line (200+ chars), so it
        // is capped to its first sentence / lead clause (≤ 100, shared/utils/pr-title).
        const fallbackTitle = capPRTitle(task.title) || `auto-claude: ${task.specId}`;

        if (taskBaseBranch) {
          debug('Using stored base branch:', taskBaseBranch);
        }

        // Get tool paths
        const gitPath = getToolPath('git');

        // zeenha fork: open a GitLab merge request only when GitLab is configured
        // AND origin is on that instance's host. A project may keep GitLab
        // configured for issues while its origin lives on GitHub; that stays a gh PR.
        let gitlabConfig = await getGitLabConfig(project);
        if (gitlabConfig) {
          let originUrl = '';
          try {
            const { stdout } = await promisify(execFile)(gitPath, ['remote', 'get-url', 'origin'], {
              cwd: project.path,
              timeout: 10000,
            });
            originUrl = String(stdout).trim();
          } catch (err) {
            debug('Could not read origin URL; using GitHub:', err);
          }
          if (!originUrl || !originMatchesInstance(originUrl, gitlabConfig.instanceUrl)) {
            gitlabConfig = null;
          }
        }

        const prConfig = {
          projectDir: project.path,
          worktreePath,
          specId: task.specId,
          branchName,
          baseBranch,
          title: typedTitle,
          fallbackTitle,
          taskTitle: task.title ?? '',
          draft: options?.draft,
          gitPath,
          subtaskProgress: readSubtaskProgress([
            path.join(worktreePath, project.autoBuildPath || '.auto-claude', 'specs', task.specId),
            specDir,
          ]),
        };

        debug('Creating PR via TypeScript runner:', { branchName, baseBranch, typedTitle, gitlab: !!gitlabConfig });

        // Run the TypeScript PR/MR creator
        const result = gitlabConfig
          ? await createMR({ ...prConfig, gitlab: gitlabConfig })
          : await createPR({ ...prConfig, ghPath: getToolPath('gh') });

        debug('PR creation result:', result);

        // zeenha fork: an existing PR for this task's own branch is still this
        // task's PR (a lost reply on the first attempt, or Create PR again after
        // the merge queue sent it back). Record it, or the task stays in Human
        // Review with no link and every later click only says "already exists".
        if (result.success && result.prUrl) {
          // Update task status after successful PR creation
          await updateTaskStatusAfterPRCreation(
            specDir,
            worktreePath,
            result.prUrl,
            project.autoBuildPath,
            task.specId,
            debug
          );

          // zeenha fork: tell the task's state machine too. The plan file now says
          // `done`, but the in-memory actor stayed in human_review, so it kept
          // writing xstateState "human_review" next to status "done" and, until the
          // next restart, still accepted "resume" on a task whose PR was open.
          try {
            taskStateManager.handleManualStatusChange(taskId, 'done', task, project);
          } catch (err) {
            debug('Failed to move the task state machine to done after PR creation:', err);
          }

          // Update linked roadmap feature
          if (project.path && task.specId) {
            const roadmapFile = path.join(project.path, AUTO_BUILD_PATHS.ROADMAP_DIR, AUTO_BUILD_PATHS.ROADMAP_FILE);
            updateRoadmapFeatureOutcome(roadmapFile, [task.specId], 'completed', '[PR_CREATE]').catch((err) => {
              debug('Failed to update roadmap feature after PR creation:', err);
            });
          }
        } else if (result.alreadyExists) {
          debug('PR already exists but its URL could not be read; task status unchanged');
        }

        if (result.success) {
          return {
            success: true,
            data: {
              success: true,
              prUrl: result.prUrl,
              alreadyExists: result.alreadyExists
            }
          };
        }

        return fail(result.errorCode ?? 'UNKNOWN', result.error || 'Failed to create PR');
      } catch (error) {
        console.error('[CREATE_PR] Exception in handler:', error);
        return fail('UNKNOWN', error instanceof Error ? error.message : 'Failed to create PR');
      }
    }
  );
}
