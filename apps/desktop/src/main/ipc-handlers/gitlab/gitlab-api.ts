/**
 * Electron-free GitLab API helpers.
 *
 * zeenha fork: split out of ./utils.ts because utils.ts imports env-utils
 * (which pulls in electron) for the glab CLI token fallback. The headless task
 * write-back path cannot load electron, so it imports this module instead.
 * Keep this file free of electron-dependent imports.
 */

import { readFile, access } from 'fs/promises';
import path from 'path';
import type { Project } from '../../../shared/types';
import { parseEnvFile } from '../utils';
import type { GitLabConfig } from './types';

export const DEFAULT_GITLAB_URL = 'https://gitlab.com';

/**
 * Custom error class for GitLab API errors with structured status code
 */
export class GitLabAPIError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'GitLabAPIError';
    this.statusCode = statusCode;
  }
}

export function parseInstanceUrl(value: string): string | null {
  const candidate = value.trim();
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
    if (parsed.username || parsed.password) {
      return null;
    }
    if (!parsed.hostname) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function normalizeInstanceUrl(value: string | undefined): string | null {
  const candidate = value || DEFAULT_GITLAB_URL;
  return parseInstanceUrl(candidate);
}

export function sanitizeToken(value: string | undefined): string | null {
  if (!value) return null;
  let sanitized = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1F || code === 0x7F) {
      continue;
    }
    sanitized += value[i];
  }
  const trimmed = sanitized.trim();
  if (!trimmed) return null;
  return trimmed.length > 512 ? trimmed.substring(0, 512) : trimmed;
}

// Max length for project references (group/project paths)
// GitLab limits project paths to 255 chars, using 1024 as defense-in-depth
const MAX_PROJECT_REF_LENGTH = 1024;

export function sanitizeProjectRef(value: string | undefined): string | null {
  if (!value) return null;
  let sanitized = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1F || code === 0x7F) {
      continue;
    }
    sanitized += value[i];
  }
  const trimmed = sanitized.trim();
  if (!trimmed) return null;
  // Reject excessively long inputs as defense-in-depth
  if (trimmed.length > MAX_PROJECT_REF_LENGTH) return null;
  return trimmed;
}

// GitLab environment variable keys (must match env-handlers.ts)
const GITLAB_ENV_KEYS = {
  ENABLED: 'GITLAB_ENABLED',
  TOKEN: 'GITLAB_TOKEN',
  INSTANCE_URL: 'GITLAB_INSTANCE_URL',
  PROJECT: 'GITLAB_PROJECT'
} as const;

/**
 * Check if a file exists (async)
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read GitLab configuration from the project environment file.
 * `tokenFallback` (sync, receives the instance URL) is called when
 * GITLAB_TOKEN is not in .env.
 * Returns null if GitLab is explicitly disabled via GITLAB_ENABLED=false
 */
export async function readGitLabEnvConfig(
  project: Project,
  tokenFallback?: (instanceUrl: string) => string | null
): Promise<GitLabConfig | null> {
  if (!project.autoBuildPath) return null;
  const envPath = path.join(project.path, project.autoBuildPath, '.env');
  if (!(await fileExists(envPath))) return null;

  try {
    const content = await readFile(envPath, 'utf-8');
    const vars = parseEnvFile(content);

    // Check if GitLab is explicitly disabled
    if (vars[GITLAB_ENV_KEYS.ENABLED]?.toLowerCase() === 'false') {
      return null;
    }

    let token = sanitizeToken(vars[GITLAB_ENV_KEYS.TOKEN]);
    const projectRef = sanitizeProjectRef(vars[GITLAB_ENV_KEYS.PROJECT]);
    const instanceUrl = normalizeInstanceUrl(vars[GITLAB_ENV_KEYS.INSTANCE_URL]);
    if (!instanceUrl) return null;

    // If no token in .env, try the fallback (e.g. glab CLI)
    if (!token && tokenFallback) {
      const fallbackToken = sanitizeToken(tokenFallback(instanceUrl) ?? undefined);
      if (fallbackToken) {
        token = fallbackToken;
      }
    }

    if (!token || !projectRef) return null;
    return { token, instanceUrl, project: projectRef };
  } catch {
    return null;
  }
}

/**
 * Normalize a GitLab project reference to group/project format
 * Handles:
 * - group/project (already normalized)
 * - group/subgroup/project (nested groups)
 * - https://gitlab.com/group/project
 * - https://gitlab.com/group/project.git
 * - git@gitlab.com:group/project.git
 * - Numeric project ID (returns as-is)
 */
export function normalizeProjectReference(project: string, instanceUrl: string = DEFAULT_GITLAB_URL): string {
  if (!project) return '';

  // If it's a numeric ID, return as-is
  if (/^\d+$/.test(project)) {
    return project;
  }

  // Remove trailing .git if present
  let normalized = project.replace(/\.git$/, '');

  // Extract hostname for comparison
  let gitlabHostname: string;
  try {
    gitlabHostname = new URL(instanceUrl).hostname;
  } catch {
    gitlabHostname = 'gitlab.com';
  }

  // Escape special regex characters in hostname to prevent ReDoS
  const escapedHostname = gitlabHostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Handle full GitLab URLs
  const httpsPattern = new RegExp(`^https?://${escapedHostname}/`);
  if (httpsPattern.test(normalized)) {
    normalized = normalized.replace(httpsPattern, '');
  } else if (normalized.startsWith(`git@${gitlabHostname}:`)) {
    normalized = normalized.replace(`git@${gitlabHostname}:`, '');
  }

  return normalized.trim();
}

/**
 * URL-encode a project path for GitLab API
 * GitLab API requires project paths to be URL-encoded (e.g., group%2Fproject)
 */
export function encodeProjectPath(projectPath: string): string {
  // If it's a numeric ID, return as-is
  if (/^\d+$/.test(projectPath)) {
    return projectPath;
  }
  return encodeURIComponent(projectPath);
}

// Default timeout for GitLab API requests (30 seconds)
export const GITLAB_API_TIMEOUT_MS = 30000;

/**
 * Make a request to the GitLab API with timeout
 */
export async function gitlabFetch(
  token: string,
  instanceUrl: string,
  endpoint: string,
  options: RequestInit = {}
): Promise<unknown> {
  // Ensure instanceUrl doesn't have trailing slash
  const baseUrl = parseInstanceUrl(instanceUrl);
  if (!baseUrl) {
    throw new Error('Invalid GitLab instance URL');
  }
  if (!endpoint.startsWith('/')) {
    throw new Error('GitLab endpoint must be a relative path');
  }
  const url = `${baseUrl}/api/v4${endpoint}`;
  const safeToken = sanitizeToken(token);
  if (!safeToken) {
    throw new Error('Invalid GitLab token');
  }

  // Create abort controller for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GITLAB_API_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
        'PRIVATE-TOKEN': safeToken
      }
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new GitLabAPIError(
        `GitLab API error: ${response.status} ${response.statusText} - ${errorBody}`,
        response.status
      );
    }

    return response.json();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new GitLabAPIError(`GitLab API timeout after ${GITLAB_API_TIMEOUT_MS / 1000}s: ${url}`, 0);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
