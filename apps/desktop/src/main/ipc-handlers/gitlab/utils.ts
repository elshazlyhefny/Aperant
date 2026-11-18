/**
 * GitLab utility functions
 */

import { execFileSync } from 'child_process';
import type { Project } from '../../../shared/types';
import type { GitLabConfig, GitLabAPIMergeRequest, CreateMergeRequestOptions } from './types';
import { getAugmentedEnv } from '../../env-utils';
import { getIsolatedGitEnv } from '../../utils/git-isolation';
import {
  DEFAULT_GITLAB_URL,
  GITLAB_API_TIMEOUT_MS,
  GitLabAPIError,
  encodeProjectPath,
  gitlabFetch,
  parseInstanceUrl,
  readGitLabEnvConfig,
  sanitizeToken
} from './gitlab-api';

// zeenha fork: electron-free pieces live in ./gitlab-api so headless code can use them.
export {
  GitLabAPIError,
  encodeProjectPath,
  gitlabFetch,
  normalizeProjectReference,
  parseInstanceUrl,
  readGitLabEnvConfig,
  sanitizeProjectRef,
  sanitizeToken
} from './gitlab-api';

/**
 * Get GitLab token from glab CLI if available
 * Uses augmented PATH to find glab CLI in common locations
 */
function getTokenFromGlabCli(instanceUrl?: string): string | null {
  try {
    // glab auth token outputs the token for the current authenticated host
    const args = ['auth', 'token'];
    if (instanceUrl) {
      const normalized = parseInstanceUrl(instanceUrl);
      if (normalized) {
        const hostname = new URL(normalized).hostname;
        if (hostname !== 'gitlab.com') {
          // For self-hosted, specify the hostname
          args.push('--hostname', hostname);
        }
      }
    }

    const token = execFileSync('glab', args, {
      encoding: 'utf-8',
      stdio: 'pipe',
      env: getAugmentedEnv()
    }).trim();
    return token || null;
  } catch {
    return null;
  }
}

/**
 * Get GitLab configuration from project environment file
 * Falls back to glab CLI token if GITLAB_TOKEN not in .env
 * Returns null if GitLab is explicitly disabled via GITLAB_ENABLED=false
 */
export async function getGitLabConfig(project: Project): Promise<GitLabConfig | null> {
  return readGitLabEnvConfig(project, getTokenFromGlabCli);
}

/**
 * Like gitlabFetch, but returns the response body as text (e.g. job traces).
 */
export async function gitlabFetchText(
  token: string,
  instanceUrl: string,
  endpoint: string
): Promise<string> {
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

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GITLAB_API_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'PRIVATE-TOKEN': safeToken }
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new GitLabAPIError(
        `GitLab API error: ${response.status} ${response.statusText} - ${errorBody}`,
        response.status
      );
    }

    return await response.text();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new GitLabAPIError(`GitLab API timeout after ${GITLAB_API_TIMEOUT_MS / 1000}s: ${url}`, 0);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Create a merge request via the GitLab API
 */
export async function createGitLabMergeRequest(
  config: GitLabConfig,
  options: CreateMergeRequestOptions
): Promise<GitLabAPIMergeRequest> {
  const encodedProject = encodeProjectPath(config.project);

  const mrBody: Record<string, unknown> = {
    source_branch: options.sourceBranch,
    target_branch: options.targetBranch,
    title: options.title
  };

  if (options.description !== undefined) {
    mrBody.description = options.description;
  }

  if (options.labels !== undefined) {
    mrBody.labels = options.labels.join(',');
  }

  if (options.assigneeIds !== undefined) {
    mrBody.assignee_ids = options.assigneeIds;
  }

  if (options.removeSourceBranch !== undefined) {
    mrBody.remove_source_branch = options.removeSourceBranch;
  }

  if (options.squash !== undefined) {
    mrBody.squash = options.squash;
  }

  return await gitlabFetch(
    config.token,
    config.instanceUrl,
    `/projects/${encodedProject}/merge_requests`,
    {
      method: 'POST',
      body: JSON.stringify(mrBody)
    }
  ) as GitLabAPIMergeRequest;
}

/**
 * Find an open merge request for a source branch (optionally a target branch)
 */
export async function findOpenMergeRequestForBranch(
  config: GitLabConfig,
  sourceBranch: string,
  targetBranch?: string
): Promise<GitLabAPIMergeRequest | null> {
  const encodedProject = encodeProjectPath(config.project);
  let query = `state=opened&source_branch=${encodeURIComponent(sourceBranch)}`;
  if (targetBranch) {
    query += `&target_branch=${encodeURIComponent(targetBranch)}`;
  }
  query += '&per_page=1';

  const mrs = await gitlabFetch(
    config.token,
    config.instanceUrl,
    `/projects/${encodedProject}/merge_requests?${query}`
  ) as GitLabAPIMergeRequest[];

  return Array.isArray(mrs) && mrs.length > 0 ? mrs[0] : null;
}

/**
 * Make a request to the GitLab API and return both data and total count from headers
 * Useful for paginated endpoints where we need the total count
 */
export async function gitlabFetchWithCount(
  token: string,
  instanceUrl: string,
  endpoint: string,
  options: RequestInit = {}
): Promise<{ data: unknown; totalCount: number }> {
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

    // Get total count from X-Total header (GitLab's pagination header)
    const totalCountHeader = response.headers.get('X-Total');
    const totalCount = totalCountHeader ? parseInt(totalCountHeader, 10) : 0;

    const data = await response.json();
    return { data, totalCount };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new GitLabAPIError(`GitLab API timeout after ${GITLAB_API_TIMEOUT_MS / 1000}s: ${url}`, 0);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Get project ID from a project path
 * GitLab API can work with either numeric IDs or URL-encoded paths
 */
export async function getProjectIdFromPath(
  token: string,
  instanceUrl: string,
  pathWithNamespace: string
): Promise<number> {
  const encodedPath = encodeProjectPath(pathWithNamespace);
  const project = await gitlabFetch(token, instanceUrl, `/projects/${encodedPath}`) as { id: number };
  return project.id;
}

/**
 * Detect GitLab project from git remote URL
 */
export function detectGitLabProjectFromRemote(projectPath: string): { project: string; instanceUrl: string } | null {
  try {
    const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: 'pipe',
      env: getIsolatedGitEnv()
    }).trim();

    if (!remoteUrl) return null;

    // Parse the remote URL to extract instance URL and project path
    let instanceUrl = DEFAULT_GITLAB_URL;
    let project = '';

    // SSH format: git@gitlab.example.com:group/project.git
    const sshMatch = remoteUrl.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
    if (sshMatch) {
      instanceUrl = `https://${sshMatch[1]}`;
      project = sshMatch[2];
    }

    // HTTPS format: https://gitlab.example.com/group/project.git
    const httpsMatch = remoteUrl.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
    if (httpsMatch) {
      instanceUrl = `https://${httpsMatch[1]}`;
      project = httpsMatch[2];
    }

    if (project) {
      return { project, instanceUrl };
    }

    return null;
  } catch {
    return null;
  }
}
