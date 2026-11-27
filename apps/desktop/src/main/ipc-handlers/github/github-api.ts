/**
 * Electron-free GitHub API helpers.
 *
 * zeenha fork: split out of ./utils.ts because utils.ts imports cli-tool-manager
 * and env-utils (which pull in electron) for the gh CLI token fallback. The
 * headless task write-back path cannot load electron, so it imports this module
 * instead. Keep this file free of electron-dependent imports.
 */

import { existsSync, readFileSync } from 'fs';
import path from 'path';
import type { Project } from '../../../shared/types';
import { parseEnvFile } from '../utils';
import type { GitHubConfig } from './types';

/**
 * Read GitHub configuration from the project environment file.
 * `tokenFallback` (sync) is called when GITHUB_TOKEN is not in .env.
 */
export function readGitHubEnvConfig(
  project: Project,
  tokenFallback?: () => string | null
): GitHubConfig | null {
  if (!project.autoBuildPath) return null;
  const envPath = path.join(project.path, project.autoBuildPath, '.env');
  if (!existsSync(envPath)) return null;

  try {
    const content = readFileSync(envPath, 'utf-8');
    const vars = parseEnvFile(content);
    let token: string | undefined = vars['GITHUB_TOKEN'];
    const repo = vars['GITHUB_REPO'];

    // If no token in .env, try the fallback (e.g. gh CLI)
    if (!token && tokenFallback) {
      const fallbackToken = tokenFallback();
      if (fallbackToken) {
        token = fallbackToken;
      }
    }

    if (!token || !repo) return null;
    return { token, repo };
  } catch {
    return null;
  }
}

/**
 * Normalize a GitHub repository reference to owner/repo format
 * Handles:
 * - owner/repo (already normalized)
 * - https://github.com/owner/repo
 * - https://github.com/owner/repo.git
 * - git@github.com:owner/repo.git
 */
export function normalizeRepoReference(repo: string): string {
  if (!repo) return '';

  // Remove trailing .git if present
  let normalized = repo.replace(/\.git$/, '');

  // Handle full GitHub URLs
  if (normalized.startsWith('https://github.com/')) {
    normalized = normalized.replace('https://github.com/', '');
  } else if (normalized.startsWith('http://github.com/')) {
    normalized = normalized.replace('http://github.com/', '');
  } else if (normalized.startsWith('git@github.com:')) {
    normalized = normalized.replace('git@github.com:', '');
  }

  return normalized.trim();
}

/** zeenha fork: expose HTTP rejection status without parsing the existing error message. */
export class GitHubAPIError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
  }
}

/** Make a request to the GitHub API. */
export async function githubFetch(
  token: string,
  endpoint: string,
  options: RequestInit = {}
): Promise<unknown> {
  const url = endpoint.startsWith('http')
    ? endpoint
    : `https://api.github.com${endpoint}`;

  // CodeQL: file data in outbound request - validate token is a non-empty string before use
  const safeToken = typeof token === 'string' && token.length > 0 ? token : '';
  const response = await fetch(url, {
    ...options,
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${safeToken}`,
      'User-Agent': 'Aperant',
      ...options.headers
    }
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'Request failed');
    throw new GitHubAPIError(`GitHub API error: ${response.status} - ${errorBody}`, response.status);
  }

  return response.json();
}
