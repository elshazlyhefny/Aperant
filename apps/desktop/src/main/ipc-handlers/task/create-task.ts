import { AUTO_BUILD_PATHS, getSpecsDir, VALID_THINKING_LEVELS, sanitizeThinkingLevel } from '../../../shared/constants';
import type { IPCResult, Task, TaskMetadata } from '../../../shared/types';
import path from 'path';
import { existsSync, writeFileSync, mkdirSync, readdirSync, Dirent } from 'fs';
import { projectStore } from '../../project-store';
import { titleGenerator } from '../../title-generator';
import { safeBreadcrumb } from '../../sentry';
import { buildSpecId } from '../../utils/spec-slug';

/**
 * Sanitize thinking levels in task metadata in-place.
 * Maps legacy values (e.g. 'ultrathink' → 'high') and defaults unknown values to 'medium'.
 */
export function sanitizeThinkingLevels(metadata: TaskMetadata): void {
  const isValid = (val: string): boolean => VALID_THINKING_LEVELS.includes(val as typeof VALID_THINKING_LEVELS[number]);

  if (metadata.thinkingLevel && !isValid(metadata.thinkingLevel)) {
    const mapped = sanitizeThinkingLevel(metadata.thinkingLevel);
    console.warn(`[TASK_CRUD] Sanitized invalid thinkingLevel "${metadata.thinkingLevel}" to "${mapped}"`);
    metadata.thinkingLevel = mapped as TaskMetadata['thinkingLevel'];
  }

  if (metadata.phaseThinking) {
    for (const phase of Object.keys(metadata.phaseThinking) as Array<keyof typeof metadata.phaseThinking>) {
      if (!isValid(metadata.phaseThinking[phase])) {
        const mapped = sanitizeThinkingLevel(metadata.phaseThinking[phase]);
        console.warn(`[TASK_CRUD] Sanitized invalid phaseThinking.${phase} "${metadata.phaseThinking[phase]}" to "${mapped}"`);
        metadata.phaseThinking[phase] = mapped as typeof metadata.phaseThinking[typeof phase];
      }
    }
  }
}

/**
 * Generate a title from a description using AI, with Sentry breadcrumbs and fallback.
 * Shared between TASK_CREATE and TASK_UPDATE handlers.
 */
export async function generateTitleWithFallback(
  description: string,
  handler: string,
  taskId?: string,
): Promise<string> {
  const breadcrumbData = taskId ? { handler, taskId } : { handler };

  safeBreadcrumb({
    category: 'task-crud',
    message: 'Title generation invoked (empty title detected)',
    level: 'info',
    data: { ...breadcrumbData, descriptionLength: description.length },
  });

  try {
    const generatedTitle = await titleGenerator.generateTitle(description);
    if (generatedTitle) {
      console.warn(`[${handler}] Generated title:`, generatedTitle);
      safeBreadcrumb({
        category: 'task-crud',
        message: 'Title generation succeeded',
        level: 'info',
        data: { ...breadcrumbData, generatedTitleLength: generatedTitle.length },
      });
      return generatedTitle;
    }

    // Fallback: create title from first line of description
    const fallback = truncateToTitle(description);
    console.warn(`[${handler}] AI generation failed, using fallback:`, fallback);
    safeBreadcrumb({
      category: 'task-crud',
      message: 'Title generation returned null, using description truncation fallback',
      level: 'warning',
      data: { ...breadcrumbData, fallbackTitle: fallback },
    });
    return fallback;
  } catch (err) {
    console.error(`[${handler}] Title generation error:`, err);
    const fallback = truncateToTitle(description);
    safeBreadcrumb({
      category: 'task-crud',
      message: 'Title generation error, using description truncation fallback',
      level: 'error',
      data: { ...breadcrumbData, error: err instanceof Error ? err.message : String(err) },
    });
    return fallback;
  }
}

/**
 * Truncate a description to a short title (first line, max 60 chars).
 */
function truncateToTitle(description: string): string {
  let title = description.split('\n')[0].substring(0, 60);
  if (title.length === 60) title += '...';
  return title;
}

/**
 * Create a new task spec on disk. Shared by the TASK_CREATE IPC handler and the scheduler.
 */
export async function createTaskSpec(
  projectId: string,
  title: string,
  description: string,
  metadata?: TaskMetadata
): Promise<IPCResult<Task>> {
  const project = projectStore.getProject(projectId);
  if (!project) {
    return { success: false, error: 'Project not found' };
  }

  // Auto-generate title if empty using Claude AI
  let finalTitle = title;
  if (!title || !title.trim()) {
    console.warn('[TASK_CREATE] Title is empty, generating with Claude AI...');
    finalTitle = await generateTitleWithFallback(description, 'TASK_CREATE');
  }

  // Generate a unique spec ID based on existing specs
  const specsBaseDir = getSpecsDir(project.autoBuildPath);
  const specsDir = path.join(project.path, specsBaseDir);

  // Find next available spec number
  let specNumber = 1;
  if (existsSync(specsDir)) {
    const existingDirs = readdirSync(specsDir, { withFileTypes: true })
      .filter((d: Dirent) => d.isDirectory())
      .map((d: Dirent) => d.name);

    // Extract numbers from spec directory names (e.g., "001-feature" -> 1)
    const existingNumbers = existingDirs
      .map((name: string) => {
        const match = name.match(/^(\d+)/);
        return match ? parseInt(match[1], 10) : 0;
      })
      .filter((n: number) => n > 0);

    if (existingNumbers.length > 0) {
      specNumber = Math.max(...existingNumbers) + 1;
    }
  }

  // Create spec ID with zero-padded number and slugified title
  const specId = buildSpecId(specNumber, finalTitle);

  // Create spec directory
  const specDir = path.join(specsDir, specId);
  mkdirSync(specDir, { recursive: true });

  // Build metadata with source type
  const taskMetadata: TaskMetadata = {
    sourceType: 'manual',
    ...metadata
  };

  // Process and save attached images
  if (taskMetadata.attachedImages && taskMetadata.attachedImages.length > 0) {
    const attachmentsDir = path.join(specDir, 'attachments');
    mkdirSync(attachmentsDir, { recursive: true });
    const resolvedAttachmentsDir = path.resolve(attachmentsDir);

    // MIME type allowlist (defense in depth - frontend also validates)
    const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/svg+xml'];

    const savedImages: typeof taskMetadata.attachedImages = [];

    for (const image of taskMetadata.attachedImages) {
      if (image.data) {
        // Validate MIME type
        if (!image.mimeType || !ALLOWED_MIME_TYPES.includes(image.mimeType)) {
          console.warn(`[TASK_CREATE] Skipping image with missing or disallowed MIME type: ${image.mimeType}`);
          continue;
        }

        // Sanitize filename to prevent path traversal attacks
        const sanitizedFilename = path.basename(image.filename);
        if (!sanitizedFilename || sanitizedFilename === '.' || sanitizedFilename === '..') {
          console.warn(`[TASK_CREATE] Skipping image with invalid filename: ${image.filename}`);
          continue;
        }

        // Validate resolved path stays within attachments directory
        const imagePath = path.join(attachmentsDir, sanitizedFilename);
        const resolvedPath = path.resolve(imagePath);
        if (!resolvedPath.startsWith(resolvedAttachmentsDir + path.sep)) {
          console.warn(`[TASK_CREATE] Skipping image with path traversal attempt: ${image.filename}`);
          continue;
        }

        try {
          // Decode base64 and save to file
          const buffer = Buffer.from(image.data, 'base64');
          writeFileSync(imagePath, buffer);

          // Store relative path instead of base64 data
          savedImages.push({
            id: image.id,
            filename: sanitizedFilename,
            mimeType: image.mimeType,
            size: image.size,
            path: `attachments/${sanitizedFilename}`
            // Don't include data or thumbnail to save space
          });
        } catch (err) {
          console.error(`Failed to save image ${sanitizedFilename}:`, err);
        }
      }
    }

    // Update metadata with saved image paths (without base64 data)
    taskMetadata.attachedImages = savedImages;
  }

  // Create initial implementation_plan.json (task is created but not started)
  const now = new Date().toISOString();
  const implementationPlan = {
    feature: finalTitle,
    description: description,
    created_at: now,
    updated_at: now,
    status: 'pending',
    phases: []
  };

  const planPath = path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
  writeFileSync(planPath, JSON.stringify(implementationPlan, null, 2), 'utf-8');

  // Save task metadata if provided (sanitize thinking levels before writing)
  if (taskMetadata) {
    sanitizeThinkingLevels(taskMetadata);
    const metadataPath = path.join(specDir, 'task_metadata.json');
    writeFileSync(metadataPath, JSON.stringify(taskMetadata, null, 2), 'utf-8');
    console.warn(`[TASK_CREATE] [Fast Mode] ${taskMetadata.fastMode ? 'ENABLED' : 'disabled'} — written to task_metadata.json for spec ${specId}`);
  }

  // Create requirements.json with attached images
  const requirements: Record<string, unknown> = {
    task_description: description,
    workflow_type: taskMetadata.category || 'feature'
  };

  // Add attached images to requirements if present
  if (taskMetadata.attachedImages && taskMetadata.attachedImages.length > 0) {
    requirements.attached_images = taskMetadata.attachedImages.map(img => ({
      filename: img.filename,
      path: img.path,
      description: '' // User can add descriptions later
    }));
  }

  const requirementsPath = path.join(specDir, AUTO_BUILD_PATHS.REQUIREMENTS);
  writeFileSync(requirementsPath, JSON.stringify(requirements, null, 2), 'utf-8');

  // Create the task object
  const task: Task = {
    id: specId,
    specId: specId,
    projectId,
    title: finalTitle,
    description,
    status: 'backlog',
    subtasks: [],
    logs: [],
    metadata: taskMetadata,
    specsPath: specDir,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  // Invalidate cache since a new task was created
  projectStore.invalidateTasksCache(projectId);

  return { success: true, data: task };
}
