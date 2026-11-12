import path from 'path';
import { AUTO_BUILD_PATHS, getSpecsDir } from '../../../shared/constants';
import type { WorktreeCreatePROptions } from '../../../shared/types';
import { persistPlanStatus, updateTaskMetadataPrUrl } from './plan-file-utils';
import { GIT_BRANCH_REGEX } from './worktree-git-utils';

// Maximum PR title length (GitHub's limit is 256 characters)
export const MAX_PR_TITLE_LENGTH = 256;

// Regex for validating PR title contains only printable characters
export const PRINTABLE_CHARS_REGEX = /^[\x20-\x7E\u00A0-\uFFFF]*$/;

// Timeout for PR creation operations (2 minutes for network operations)
export const PR_CREATION_TIMEOUT_MS = 120000;

// ============================================
// Helper functions for TASK_WORKTREE_CREATE_PR
// ============================================

/**
 * Result of parsing JSON output from the create-pr Python script
 */
export interface ParsedPRResult {
  success: boolean;
  prUrl?: string;
  alreadyExists?: boolean;
  error?: string;
}

/**
 * Validate that a URL is a valid HTTPS URL for a pull or merge request.
 * Provider-neutral: github.com, GitHub Enterprise, gitlab.com and self-hosted
 * GitLab all pass. Only requires HTTPS and a non-empty hostname.
 * @returns true if the URL is a valid HTTPS URL with a non-empty hostname
 */
export function isValidHttpsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * Extract the lowercase host from a git remote URL (SSH scp-style,
 * scheme URLs such as ssh:// or https://). Ports are ignored.
 */
function remoteHost(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).hostname.toLowerCase() || null;
    } catch {
      return null;
    }
  }
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)/.exec(trimmed);
  return scp ? scp[1].toLowerCase() : null;
}

/**
 * zeenha fork: true when a git remote URL points at the given GitLab instance.
 * Compares hosts case-insensitively and ignores ports on the remote, so a
 * project with GitLab configured but a GitHub origin still opens a GitHub PR.
 */
export function originMatchesInstance(remoteUrl: string, instanceUrl: string): boolean {
  let instanceHost: string;
  try {
    instanceHost = new URL(instanceUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!instanceHost) return false;
  return remoteHost(remoteUrl) === instanceHost;
}

/**
 * Parse JSON output from the create-pr Python script
 * Handles both snake_case and camelCase field names
 * @returns ParsedPRResult if valid JSON found, null otherwise
 */
export function parsePRJsonOutput(stdout: string): ParsedPRResult | null {
  // Find the last complete JSON object in stdout (non-greedy, handles multiple objects)
  const jsonMatches = stdout.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g);
  const jsonMatch = jsonMatches && jsonMatches.length > 0 ? jsonMatches[jsonMatches.length - 1] : null;

  if (!jsonMatch) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonMatch);

    // Validate parsed JSON has expected shape
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }

    // Extract and validate fields with proper type checking
    // Handle both snake_case (from Python) and camelCase field names
    // Default success to false to avoid masking failures when field is missing
    const rawPrUrl = typeof parsed.pr_url === 'string' ? parsed.pr_url :
                     typeof parsed.prUrl === 'string' ? parsed.prUrl : undefined;

    // Validate PR URL is a valid HTTPS URL for robustness
    const validatedPrUrl = rawPrUrl && isValidHttpsUrl(rawPrUrl) ? rawPrUrl : undefined;

    return {
      success: typeof parsed.success === 'boolean' ? parsed.success : false,
      prUrl: validatedPrUrl,
      alreadyExists: typeof parsed.already_exists === 'boolean' ? parsed.already_exists :
                     typeof parsed.alreadyExists === 'boolean' ? parsed.alreadyExists : undefined,
      error: typeof parsed.error === 'string' ? parsed.error : undefined
    };
  } catch {
    return null;
  }
}

/**
 * Result of updating task status after PR creation
 */
export interface TaskStatusUpdateResult {
  mainProjectStatus: boolean;
  mainProjectMetadata: boolean;
  worktreeStatus: boolean;
  worktreeMetadata: boolean;
}

/**
 * Update task status and metadata after PR creation
 * Updates both main project and worktree locations
 * @returns Result object indicating which updates succeeded/failed
 */
export async function updateTaskStatusAfterPRCreation(
  specDir: string,
  worktreePath: string | null,
  prUrl: string,
  autoBuildPath: string | undefined,
  specId: string,
  debug: (...args: unknown[]) => void
): Promise<TaskStatusUpdateResult> {
  const result: TaskStatusUpdateResult = {
    mainProjectStatus: false,
    mainProjectMetadata: false,
    worktreeStatus: false,
    worktreeMetadata: false
  };

  const planPath = path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
  const metadataPath = path.join(specDir, 'task_metadata.json');

  // Await status persistence to ensure completion before resolving
  try {
    const persisted = await persistPlanStatus(planPath, 'done');
    result.mainProjectStatus = persisted;
    debug('Main project status persisted to done:', persisted);
  } catch (err) {
    debug('Failed to persist main project status:', err);
  }

  // Update metadata with prUrl in main project
  result.mainProjectMetadata = updateTaskMetadataPrUrl(metadataPath, prUrl);
  debug('Main project metadata updated with prUrl:', result.mainProjectMetadata);

  // Also persist to WORKTREE location (worktree takes priority when loading tasks)
  // This ensures the status persists after refresh since getTasks() prefers worktree version
  if (worktreePath) {
    const specsBaseDir = getSpecsDir(autoBuildPath);
    const worktreePlanPath = path.join(worktreePath, specsBaseDir, specId, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
    const worktreeMetadataPath = path.join(worktreePath, specsBaseDir, specId, 'task_metadata.json');

    try {
      const persisted = await persistPlanStatus(worktreePlanPath, 'done');
      result.worktreeStatus = persisted;
      debug('Worktree status persisted to done:', persisted);
    } catch (err) {
      debug('Failed to persist worktree status:', err);
    }

    result.worktreeMetadata = updateTaskMetadataPrUrl(worktreeMetadataPath, prUrl);
    debug('Worktree metadata updated with prUrl:', result.worktreeMetadata);
  }

  return result;
}

/**
 * Build arguments for the create-pr Python script
 */
export function buildCreatePRArgs(
  runScript: string,
  specId: string,
  projectPath: string,
  options: WorktreeCreatePROptions | undefined,
  taskBaseBranch: string | undefined
): { args: string[]; validationError?: string } {
  const args = [
    runScript,
    '--spec', specId,
    '--project-dir', projectPath,
    '--create-pr'
  ];

  // Add optional arguments with validation
  if (options?.targetBranch) {
    // Validate branch name to prevent malformed git commands
    if (!GIT_BRANCH_REGEX.test(options.targetBranch)) {
      return { args: [], validationError: 'Invalid target branch name' };
    }
    args.push('--pr-target', options.targetBranch);
  }
  if (options?.title) {
    // Validate title for printable characters and length limit
    if (options.title.length > MAX_PR_TITLE_LENGTH) {
      return { args: [], validationError: `PR title exceeds maximum length of ${MAX_PR_TITLE_LENGTH} characters` };
    }
    if (!PRINTABLE_CHARS_REGEX.test(options.title)) {
      return { args: [], validationError: 'PR title contains invalid characters' };
    }
    args.push('--pr-title', options.title);
  }
  if (options?.draft) {
    args.push('--pr-draft');
  }

  // Add --base-branch if task was created with a specific base branch
  if (taskBaseBranch) {
    args.push('--base-branch', taskBaseBranch);
  }

  return { args };
}


/**
 * Generic retry wrapper with exponential backoff
 * @param operation - Async function to execute with retry
 * @param options - Retry configuration options
 * @returns Result of the operation or throws after all retries
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseDelayMs?: number;
    onRetry?: (attempt: number, error: unknown) => void;
    shouldRetry?: (error: unknown) => boolean;
  } = {}
): Promise<T> {
  const { maxRetries: rawMaxRetries = 3, baseDelayMs = 100, onRetry, shouldRetry } = options;

  // Ensure at least one attempt is made (clamp to minimum of 1)
  const maxRetries = Math.max(1, rawMaxRetries);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const isLastAttempt = attempt === maxRetries;

      // Check if we should retry this error
      if (shouldRetry && !shouldRetry(error)) {
        throw error;
      }

      if (isLastAttempt) {
        throw error;
      }

      // Notify about retry
      onRetry?.(attempt, error);

      // Wait before retry (exponential backoff)
      await new Promise(r => setTimeout(r, baseDelayMs * 2 ** (attempt - 1)));
    }
  }

  // This should never be reached, but TypeScript needs it
  throw new Error('Retry loop exited unexpectedly');
}
