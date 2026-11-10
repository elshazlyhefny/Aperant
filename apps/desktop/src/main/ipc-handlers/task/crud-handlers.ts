import { ipcMain, nativeImage } from 'electron';
import { IPC_CHANNELS, AUTO_BUILD_PATHS, getSpecsDir } from '../../../shared/constants';
import type { IPCResult, Task, TaskMetadata, TaskOutcome } from '../../../shared/types';
import path from 'path';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { updateRoadmapFeatureOutcome } from '../../utils/roadmap-utils';
import { projectStore } from '../../project-store';
import { AgentManager } from '../../agent';
import { findTaskAndProject } from './shared';
import { findAllSpecPaths, isValidTaskId } from '../../utils/spec-path-helpers';
import { isPathWithinBase, findTaskWorktree } from '../../worktree-paths';
import { cleanupWorktree } from '../../utils/worktree-cleanup';
import { getToolPath } from '../../cli-tool-manager';
import { getIsolatedGitEnv } from '../../utils/git-isolation';
import { taskStateManager } from '../../task-state-manager';
import { applyTokenBudget, createTaskSpec, generateTitleWithFallback, sanitizeThinkingLevels } from './create-task';
import { canResetPlan, resetPlanFiles } from './reset-plan';
import { taskSpecDirs } from '../../task-failure-facts';
import { validateDependenciesForSave } from './dependency-validation';

export { applyTokenBudget };

/**
 * Update a linked roadmap feature when a task is deleted.
 * Delegates to shared utility with file locking and retry.
 */
async function updateLinkedRoadmapFeature(
  projectPath: string,
  specId: string,
  taskOutcome: TaskOutcome
): Promise<void> {
  const roadmapFile = path.join(projectPath, AUTO_BUILD_PATHS.ROADMAP_DIR, AUTO_BUILD_PATHS.ROADMAP_FILE);
  await updateRoadmapFeatureOutcome(roadmapFile, [specId], taskOutcome, '[TASK_CRUD]');
}

/**
 * Register task CRUD (Create, Read, Update, Delete) handlers
 */
export function registerTaskCRUDHandlers(agentManager: AgentManager): void {
  /**
   * List all tasks for a project
   * @param projectId - The project ID to fetch tasks for
   * @param options - Optional parameters
   * @param options.forceRefresh - If true, invalidates cache before fetching (for refresh button)
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_LIST,
    async (_, projectId: string, options?: { forceRefresh?: boolean }): Promise<IPCResult<Task[]>> => {
      console.warn('[IPC] TASK_LIST called with projectId:', projectId, 'options:', options);

      // If forceRefresh is requested, invalidate cache and clear XState actors
      // This ensures the refresh button always returns fresh data from disk
      // and actors are recreated with fresh task data
      if (options?.forceRefresh) {
        projectStore.invalidateTasksCache(projectId);
        taskStateManager.clearAllTasks();
        console.warn('[IPC] TASK_LIST cache and task state cleared for forceRefresh');
      }

      const tasks = projectStore.getTasks(projectId);
      console.warn('[IPC] TASK_LIST returning', tasks.length, 'tasks');
      return { success: true, data: tasks };
    }
  );

  /**
   * Create a new task
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_CREATE,
    async (
      _,
      projectId: string,
      title: string,
      description: string,
      metadata?: TaskMetadata
    ): Promise<IPCResult<Task>> => createTaskSpec(projectId, title, description, metadata)
  );

  /**
   * Delete a task
   *
   * This handler:
   * 1. Checks if task exists and is not running
   * 2. Cleans up the worktree (auto-commits, deletes directory, prunes refs, deletes branch)
   * 3. Deletes all spec directories (main project + any remaining worktree locations)
   *
   * Note: Worktree cleanup uses manual deletion instead of `git worktree remove --force`
   * because the latter fails on Windows when the directory contains untracked files
   * (node_modules, build artifacts, etc.). See: https://github.com/AndyMik90/Auto-Claude/issues/1539
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_DELETE,
    async (_, taskId: string): Promise<IPCResult> => {
      const { rm } = await import('fs/promises');

      // Find task and project
      const { task, project } = findTaskAndProject(taskId);

      if (!task || !project) {
        return { success: false, error: 'Task or project not found' };
      }

      // Check if task is currently running
      const isRunning = agentManager.isRunning(taskId);
      if (isRunning) {
        return { success: false, error: 'Cannot delete a running task. Stop the task first.' };
      }

      let hasErrors = false;
      const errors: string[] = [];

      // Clean up the worktree first if it exists
      // This uses the robust cleanup that handles Windows file locking issues
      const worktreePath = findTaskWorktree(project.path, task.specId);
      if (worktreePath) {
        console.warn(`[TASK_DELETE] Found worktree at: ${worktreePath}`);
        const cleanupResult = await cleanupWorktree({
          worktreePath,
          projectPath: project.path,
          specId: task.specId,
          logPrefix: '[TASK_DELETE]',
          deleteBranch: true
        });

        if (!cleanupResult.success) {
          console.error(`[TASK_DELETE] Worktree cleanup failed:`, cleanupResult.warnings);
          hasErrors = true;
          errors.push(`Worktree cleanup: ${cleanupResult.warnings.join('; ')}`);
        } else if (cleanupResult.warnings.length > 0) {
          console.warn(`[TASK_DELETE] Cleanup warnings:`, cleanupResult.warnings);
        }
      }

      // Find ALL locations where this task exists (main + any remaining worktree dirs)
      // Following the archiveTasks() pattern from project-store.ts
      const specsBaseDir = getSpecsDir(project.autoBuildPath);
      const specPaths = findAllSpecPaths(project.path, specsBaseDir, task.specId);

      // If spec directory doesn't exist anywhere, return success (already removed)
      if (specPaths.length === 0 && !hasErrors) {
        console.warn(`[TASK_DELETE] No spec directories found for task ${taskId} - already removed`);
        projectStore.invalidateTasksCache(project.id);
        return { success: true };
      }

      // Delete from ALL locations
      for (const specDir of specPaths) {
        try {
          console.warn(`[TASK_DELETE] Attempting to delete: ${specDir}`);
          await rm(specDir, { recursive: true, force: true });
          console.warn(`[TASK_DELETE] Deleted spec directory: ${specDir}`);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          console.error(`[TASK_DELETE] Error deleting spec directory ${specDir}:`, error);
          hasErrors = true;
          errors.push(`${specDir}: ${errorMsg}`);
          // Continue with other locations even if one fails
        }
      }

      // Clear in-memory XState actor and related state for this task.
      // Without this, recreating a task with the same spec ID would hit the
      // stale actor (stuck in a terminal state like 'human_review'), causing
      // the new task's events to be silently dropped and the task to appear
      // stuck forever.
      taskStateManager.clearTask(taskId);

      // Invalidate cache since a task was deleted
      projectStore.invalidateTasksCache(project.id);

      if (hasErrors) {
        return {
          success: false,
          error: `Failed to delete some task files: ${errors.join('; ')}`
        };
      }

      // Update any linked roadmap feature (only after successful deletion)
      try {
        await updateLinkedRoadmapFeature(project.path, task.specId, 'deleted');
      } catch (err) {
        console.warn('[TASK_DELETE] Failed to update linked roadmap feature:', err);
      }

      return { success: true };
    }
  );

  /**
   * Update a task
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_UPDATE,
    async (
      _,
      taskId: string,
      updates: { title?: string; description?: string; metadata?: Partial<TaskMetadata> }
    ): Promise<IPCResult<Task>> => {
      try {
        // Find task and project
        const { task, project } = findTaskAndProject(taskId);

        if (!task || !project) {
          return { success: false, error: 'Task not found' };
        }

        const autoBuildDir = project.autoBuildPath || '.auto-claude';
        const specDir = path.join(project.path, autoBuildDir, 'specs', task.specId);

        if (!existsSync(specDir)) {
          return { success: false, error: 'Spec directory not found' };
        }

        // zeenha fork: validate task dependencies before writing anything.
        let validatedDeps: string[] | undefined;
        if (updates.metadata?.taskDependencies !== undefined) {
          const validation = validateDependenciesForSave(
            taskId,
            updates.metadata.taskDependencies,
            projectStore.getTasks(project.id)
          );
          if (!validation.ok) {
            console.warn(`[TASK_UPDATE] Rejected task dependencies: ${validation.error}`);
            return { success: false, error: validation.error };
          }
          validatedDeps = validation.deps;
        }

        // Auto-generate title if empty
        let finalTitle = updates.title;
        if (updates.title !== undefined && !updates.title.trim()) {
          const descriptionToUse = updates.description ?? task.description;
          console.warn('[TASK_UPDATE] Title is empty, generating with Claude AI...');
          finalTitle = await generateTitleWithFallback(descriptionToUse, 'TASK_UPDATE', taskId);
        }

        // Update implementation_plan.json
        const planPath = path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
        try {
          const planContent = readFileSync(planPath, 'utf-8');
          const plan = JSON.parse(planContent);

          if (finalTitle !== undefined) {
            plan.feature = finalTitle;
          }
          if (updates.description !== undefined) {
            plan.description = updates.description;
          }
          plan.updated_at = new Date().toISOString();

          writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf-8');
        } catch (planErr: unknown) {
          // File missing or invalid JSON - continue anyway
          if ((planErr as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.error('[TASK_UPDATE] Error updating implementation plan:', planErr);
          }
        }

        // Update spec.md if it exists
        const specPath = path.join(specDir, AUTO_BUILD_PATHS.SPEC_FILE);
        try {
          let specContent = readFileSync(specPath, 'utf-8');

          // Update title (first # heading)
          if (finalTitle !== undefined) {
            specContent = specContent.replace(
              /^#\s+.*$/m,
              `# ${finalTitle}`
            );
          }

          // Update description (## Overview section content)
          if (updates.description !== undefined) {
            // Replace content between ## Overview and the next ## section
            specContent = specContent.replace(
              /(## Overview\n)([\s\S]*?)((?=\n## )|$)/,
              `$1${updates.description}\n\n$3`
            );
          }

          writeFileSync(specPath, specContent, 'utf-8');
        } catch (specErr: unknown) {
          // File missing or update failed - continue anyway
          if ((specErr as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.error('[TASK_UPDATE] Error updating spec.md:', specErr);
          }
        }

        // Update metadata if provided
        let updatedMetadata = task.metadata;
        if (updates.metadata) {
          updatedMetadata = { ...task.metadata, ...updates.metadata };
          if (validatedDeps !== undefined) {
            updatedMetadata.taskDependencies = validatedDeps;
          }

          // Process and save attached images if provided
          if (updates.metadata.attachedImages && updates.metadata.attachedImages.length > 0) {
            const attachmentsDir = path.join(specDir, 'attachments');
            mkdirSync(attachmentsDir, { recursive: true });
            const resolvedAttachmentsDir = path.resolve(attachmentsDir);

            // MIME type allowlist (defense in depth - frontend also validates)
            const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/svg+xml'];

            const savedImages: typeof updates.metadata.attachedImages = [];

            for (const image of updates.metadata.attachedImages) {
              // If image has data (new image), save it
              if (image.data) {
                // Validate MIME type
                if (!image.mimeType || !ALLOWED_MIME_TYPES.includes(image.mimeType)) {
                  console.warn(`[TASK_UPDATE] Skipping image with missing or disallowed MIME type: ${image.mimeType}`);
                  continue;
                }

                // Sanitize filename to prevent path traversal attacks
                const sanitizedFilename = path.basename(image.filename);
                if (!sanitizedFilename || sanitizedFilename === '.' || sanitizedFilename === '..') {
                  console.warn(`[TASK_UPDATE] Skipping image with invalid filename: ${image.filename}`);
                  continue;
                }

                // Validate resolved path stays within attachments directory
                const imagePath = path.join(attachmentsDir, sanitizedFilename);
                const resolvedPath = path.resolve(imagePath);
                if (!resolvedPath.startsWith(resolvedAttachmentsDir + path.sep)) {
                  console.warn(`[TASK_UPDATE] Skipping image with path traversal attempt: ${image.filename}`);
                  continue;
                }

                try {
                  const buffer = Buffer.from(image.data, 'base64');
                  writeFileSync(imagePath, buffer);

                  savedImages.push({
                    id: image.id,
                    filename: sanitizedFilename,
                    mimeType: image.mimeType,
                    size: image.size,
                    path: `attachments/${sanitizedFilename}`
                  });
                } catch (err) {
                  console.error(`Failed to save image ${sanitizedFilename}:`, err);
                }
              } else if (image.path) {
                // Existing image, keep it
                savedImages.push(image);
              }
            }

            updatedMetadata.attachedImages = savedImages;
          }

          // Sanitize thinking levels and update task_metadata.json
          sanitizeThinkingLevels(updatedMetadata);
          applyTokenBudget(updatedMetadata);
          const metadataPath = path.join(specDir, 'task_metadata.json');
          try {
            writeFileSync(metadataPath, JSON.stringify(updatedMetadata, null, 2), 'utf-8');
          } catch (err) {
            console.error('Failed to update task_metadata.json:', err);
          }

          // Update requirements.json if it exists
          const requirementsPath = path.join(specDir, 'requirements.json');
          try {
            const requirementsContent = readFileSync(requirementsPath, 'utf-8');
            const requirements = JSON.parse(requirementsContent);

            if (updates.description !== undefined) {
              requirements.task_description = updates.description;
            }
            if (updates.metadata.category) {
              requirements.workflow_type = updates.metadata.category;
            }

            writeFileSync(requirementsPath, JSON.stringify(requirements, null, 2), 'utf-8');
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
              console.error('Failed to update requirements.json:', err);
            }
          }
        }

        // Build the updated task object
        const updatedTask: Task = {
          ...task,
          title: finalTitle ?? task.title,
          description: updates.description ?? task.description,
          metadata: updatedMetadata,
          updatedAt: new Date()
        };

        // Invalidate cache since a task was updated
        projectStore.invalidateTasksCache(project.id);

        return { success: true, data: updatedTask };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    }
  );

  /**
   * Load an image thumbnail from disk
   * Used to load thumbnails for images that were saved without base64 data
   * @param projectPath - The project root path
   * @param specId - The spec ID
   * @param imagePath - Relative path to the image (e.g., 'attachments/image.png')
   * @returns Base64 data URL thumbnail
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_LOAD_IMAGE_THUMBNAIL,
    async (
      _,
      projectPath: string,
      specId: string,
      imagePath: string
    ): Promise<IPCResult<string>> => {
      try {
        // Validate specId to prevent path traversal attacks
        if (!isValidTaskId(specId)) {
          console.error(`[IPC] TASK_LOAD_IMAGE_THUMBNAIL: Invalid specId rejected: "${specId}"`);
          return { success: false, error: 'Invalid spec ID' };
        }

        // Get project to determine auto-build path - validate projectPath exists
        const projects = projectStore.getProjects();
        const project = projects.find((p) => p.path === projectPath);
        if (!project) {
          console.error(`[IPC] TASK_LOAD_IMAGE_THUMBNAIL: Unknown project: "${projectPath}"`);
          return { success: false, error: 'Unknown project' };
        }
        const autoBuildPath = project.autoBuildPath || '.auto-claude';

        // Build full path to the image
        const specsDir = getSpecsDir(autoBuildPath);
        const fullImagePath = path.join(projectPath, specsDir, specId, imagePath);

        // Validate path to prevent path traversal attacks
        const expectedBase = path.resolve(path.join(projectPath, specsDir, specId));
        const resolvedPath = path.resolve(fullImagePath);
        if (!isPathWithinBase(resolvedPath, expectedBase)) {
          console.error(`[IPC] Path traversal detected: imagePath "${imagePath}" resolves outside spec directory`);
          return { success: false, error: 'Invalid image path' };
        }

        if (!existsSync(fullImagePath)) {
          return { success: false, error: `Image not found: ${imagePath}` };
        }

        // Load image using nativeImage
        const image = nativeImage.createFromPath(fullImagePath);
        if (image.isEmpty()) {
          return { success: false, error: 'Failed to load image' };
        }

        // Get original size
        const size = image.getSize();
        const maxSize = 200;

        // Calculate thumbnail dimensions while maintaining aspect ratio
        let width = size.width;
        let height = size.height;
        if (width > height) {
          if (width > maxSize) {
            height = Math.round((height * maxSize) / width);
            width = maxSize;
          }
        } else {
          if (height > maxSize) {
            width = Math.round((width * maxSize) / height);
            height = maxSize;
          }
        }

        // Resize to thumbnail
        const thumbnail = image.resize({ width, height, quality: 'good' });

        // Convert to base64 data URL
        // Use JPEG for thumbnails (smaller size, good for previews)
        const base64 = thumbnail.toJPEG(80).toString('base64');
        const dataUrl = `data:image/jpeg;base64,${base64}`;

        return { success: true, data: dataUrl };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error loading thumbnail'
        };
      }
    }
  );

  /**
   * zeenha fork: Re-plan a failed task. Discards its plan (every copy) so the
   * next start plans again. Refused for any task not in the Failed column.
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_RESET_PLAN,
    async (_, taskId: string): Promise<IPCResult> => {
      const { task, project } = findTaskAndProject(taskId);
      if (!task || !project) {
        return { success: false, error: 'Task not found' };
      }
      if (!canResetPlan(task)) {
        return { success: false, error: 'Only a failed task can be re-planned' };
      }
      const result = resetPlanFiles(taskSpecDirs(project.path, getSpecsDir(project.autoBuildPath), task.specId));
      if (!result.success) {
        return { success: false, error: result.error };
      }
      projectStore.invalidateTasksCache(project.id);
      return { success: true };
    }
  );

  /**
   * Check if a task's worktree has uncommitted changes
   * Used by the UI before showing the delete confirmation dialog
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_CHECK_WORKTREE_CHANGES,
    async (_, taskId: string): Promise<IPCResult<{ hasChanges: boolean; worktreePath?: string; changedFileCount?: number }>> => {
      const { task, project } = findTaskAndProject(taskId);
      if (!task || !project) {
        return { success: true, data: { hasChanges: false } };
      }

      const worktreePath = findTaskWorktree(project.path, task.specId);
      if (!worktreePath) {
        return { success: true, data: { hasChanges: false } };
      }

      try {
        const status = execFileSync(getToolPath('git'), ['status', '--porcelain'], {
          cwd: worktreePath,
          encoding: 'utf-8',
          env: getIsolatedGitEnv(),
          timeout: 5000
        }).trim();

        const changedFiles = status ? status.split('\n').length : 0;
        return {
          success: true,
          data: { hasChanges: changedFiles > 0, worktreePath, changedFileCount: changedFiles }
        };
      } catch {
        // On error/timeout, return false as fail-safe (don't block deletion)
        return { success: true, data: { hasChanges: false, worktreePath } };
      }
    }
  );
}
