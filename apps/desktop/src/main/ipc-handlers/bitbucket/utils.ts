/**
 * Bitbucket utility functions
 */

import { readFile, access } from 'fs/promises';
import { execFileSync } from 'child_process';
import path from 'path';
import type { Project } from '../../../shared/types';
import { parseEnvFile } from '../utils';
import type {
  BitbucketConfig,
  BitbucketAPIPullRequest,
  BitbucketAPIPage,
  BitbucketAPIComment
} from './types';
import { getIsolatedGitEnv } from '../../utils/git-isolation';

export const BITBUCKET_API_BASE = 'https://api.bitbucket.org/2.0';

// Default timeout for Bitbucket API requests (30 seconds)
export const BITBUCKET_API_TIMEOUT_MS = 30000;

export const MAX_COMMENT_LENGTH = 32768;

const MAX_TOKEN_LENGTH = 512;
const MAX_USERNAME_LENGTH = 256;
const MAX_REPO_REF_LENGTH = 256;

// workspace/repo_slug: letters, digits, '.', '_', '-' on each side
const REPO_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Bitbucket environment variable keys (must match env-handlers.ts)
const BITBUCKET_ENV_KEYS = {
  ENABLED: 'BITBUCKET_ENABLED',
  USERNAME: 'BITBUCKET_USERNAME',
  TOKEN: 'BITBUCKET_TOKEN',
  REPOSITORY: 'BITBUCKET_REPOSITORY'
} as const;

/**
 * Custom error class for Bitbucket API errors with structured status code
 */
export class BitbucketAPIError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'BitbucketAPIError';
    this.statusCode = statusCode;
  }
}

function stripControlChars(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1F || code === 0x7F) continue;
    out += value[i];
  }
  return out;
}

export function sanitizeToken(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = stripControlChars(value).trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_TOKEN_LENGTH ? trimmed.substring(0, MAX_TOKEN_LENGTH) : trimmed;
}

function sanitizeUsername(value: string | undefined): string | null {
  if (!value) return null;
  // ':' would corrupt the Basic auth credential pair
  const trimmed = stripControlChars(value).replace(/:/g, '').trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_USERNAME_LENGTH ? trimmed.substring(0, MAX_USERNAME_LENGTH) : trimmed;
}

/**
 * Sanitize a repository reference. Returns "workspace/repo_slug" or null if invalid.
 */
export function sanitizeRepoRef(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = stripControlChars(value).trim();
  if (!trimmed || trimmed.length > MAX_REPO_REF_LENGTH) return null;
  return REPO_REF_PATTERN.test(trimmed) ? trimmed : null;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get Bitbucket configuration from the project environment file.
 * Returns null if disabled via BITBUCKET_ENABLED=false or incomplete.
 */
export async function getBitbucketConfig(project: Project): Promise<BitbucketConfig | null> {
  if (!project.autoBuildPath) return null;
  const envPath = path.join(project.path, project.autoBuildPath, '.env');
  if (!(await fileExists(envPath))) return null;

  try {
    const content = await readFile(envPath, 'utf-8');
    const vars = parseEnvFile(content);

    if (vars[BITBUCKET_ENV_KEYS.ENABLED]?.toLowerCase() === 'false') {
      return null;
    }

    const username = sanitizeUsername(vars[BITBUCKET_ENV_KEYS.USERNAME]);
    const token = sanitizeToken(vars[BITBUCKET_ENV_KEYS.TOKEN]);
    const repository = sanitizeRepoRef(vars[BITBUCKET_ENV_KEYS.REPOSITORY]);

    if (!username || !token || !repository) return null;
    return { username, token, repository };
  } catch {
    return null;
  }
}

function buildUrl(endpoint: string): string {
  if (typeof endpoint !== 'string' || !endpoint.startsWith('/') || endpoint.startsWith('//')) {
    throw new Error('Bitbucket endpoint must be a relative path');
  }
  return `${BITBUCKET_API_BASE}${endpoint}`;
}

async function bitbucketRequest(
  config: Pick<BitbucketConfig, 'username' | 'token'>,
  endpoint: string,
  options: RequestInit,
  accept: string
): Promise<Response> {
  const url = buildUrl(endpoint);
  const username = sanitizeUsername(config.username);
  const token = sanitizeToken(config.token);
  if (!username || !token) {
    throw new Error('Invalid Bitbucket credentials');
  }
  const auth = Buffer.from(`${username}:${token}`).toString('base64');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BITBUCKET_API_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
        Accept: accept,
        Authorization: `Basic ${auth}`
      }
    });

    if (!response.ok) {
      // Only status and body are surfaced; request headers never appear in errors
      const errorBody = await response.text().catch(() => '');
      throw new BitbucketAPIError(
        `Bitbucket API error: ${response.status} ${response.statusText}${errorBody ? ` - ${errorBody.substring(0, 500)}` : ''}`,
        response.status
      );
    }
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new BitbucketAPIError(`Bitbucket API timeout after ${BITBUCKET_API_TIMEOUT_MS / 1000}s: ${endpoint}`, 0);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Make a JSON request to the Bitbucket API with timeout
 */
export async function bitbucketFetch(
  config: Pick<BitbucketConfig, 'username' | 'token'>,
  endpoint: string,
  options: RequestInit = {}
): Promise<unknown> {
  const response = await bitbucketRequest(config, endpoint, options, 'application/json');
  return response.json();
}

/**
 * Make a request returning plain text (used for the diff endpoint, which redirects)
 */
export async function bitbucketFetchText(
  config: Pick<BitbucketConfig, 'username' | 'token'>,
  endpoint: string,
  options: RequestInit = {}
): Promise<string> {
  const response = await bitbucketRequest(config, endpoint, options, 'text/plain');
  return response.text();
}

/**
 * zeenha fork: fetch plain text such as a pipeline step log. Unlike
 * bitbucketFetchText (which sends Accept: text/plain), the Accept header is
 * caller-chosen and defaults to a wildcard, and an optional Range header
 * limits the bytes read (e.g. 'bytes=-65536' for the tail of a log).
 */
export async function bitbucketFetchLog(
  config: Pick<BitbucketConfig, 'username' | 'token'>,
  endpoint: string,
  opts: { accept?: string; range?: string } = {}
): Promise<string> {
  const response = await bitbucketRequest(
    config,
    endpoint,
    opts.range ? { headers: { Range: opts.range } } : {},
    opts.accept ?? '*/*'
  );
  return response.text();
}

/**
 * Create a pull request from sourceBranch into destinationBranch.
 * The returned PR's links.html.href is its web URL.
 */
export async function createBitbucketPullRequest(
  config: BitbucketConfig,
  params: { sourceBranch: string; destinationBranch: string; title: string; description: string }
): Promise<BitbucketAPIPullRequest> {
  return (await bitbucketFetch(config, `/repositories/${config.repository}/pullrequests`, {
    method: 'POST',
    body: JSON.stringify({
      title: params.title,
      description: params.description,
      source: { branch: { name: params.sourceBranch } },
      destination: { branch: { name: params.destinationBranch } }
    })
  })) as BitbucketAPIPullRequest;
}

/**
 * Find an open pull request whose source branch is `sourceBranch`, or null.
 */
export async function findOpenPullRequestForBranch(
  config: BitbucketConfig,
  sourceBranch: string
): Promise<BitbucketAPIPullRequest | null> {
  const escaped = sourceBranch.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const q = encodeURIComponent(`source.branch.name="${escaped}" AND state="OPEN"`);
  const page = (await bitbucketFetch(
    config,
    `/repositories/${config.repository}/pullrequests?q=${q}&pagelen=1`
  )) as BitbucketAPIPage<BitbucketAPIPullRequest>;
  return page.values?.[0] ?? null;
}

/**
 * Return `next` only if it points at the Bitbucket API origin; otherwise null.
 * Returns the endpoint relative to the API base.
 */
export function getSafeNextEndpoint(next: string | undefined): string | null {
  if (!next) return null;
  try {
    const base = new URL(BITBUCKET_API_BASE);
    const parsed = new URL(next);
    if (parsed.origin !== base.origin || !parsed.pathname.startsWith(base.pathname)) return null;
    return `${parsed.pathname.substring(base.pathname.length)}${parsed.search}`;
  } catch {
    return null;
  }
}

/**
 * Detect Bitbucket repository from the git origin remote URL
 */
export function detectBitbucketRepositoryFromRemote(
  projectPath: string
): { workspace: string; repoSlug: string; fullName: string } | null {
  try {
    const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: 'pipe',
      env: getIsolatedGitEnv()
    }).trim();

    return parseBitbucketRemoteUrl(remoteUrl);
  } catch {
    return null;
  }
}

/**
 * Parse a Bitbucket remote URL (ssh or https, optionally with user)
 */
export function parseBitbucketRemoteUrl(
  remoteUrl: string
): { workspace: string; repoSlug: string; fullName: string } | null {
  if (!remoteUrl) return null;

  const match =
    remoteUrl.match(/^git@bitbucket\.org:([^/]+)\/(.+?)(?:\.git)?\/?$/) ||
    remoteUrl.match(/^https?:\/\/(?:[^@/]+@)?bitbucket\.org\/([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (!match) return null;

  const fullName = sanitizeRepoRef(`${match[1]}/${match[2]}`);
  if (!fullName) return null;
  const [workspace, repoSlug] = fullName.split('/');
  return { workspace, repoSlug, fullName };
}

/** Inline anchor for a pull request comment (file path plus optional line numbers) */
export interface BitbucketInlineAnchor {
  path: string;
  to?: number;
  from?: number;
}

/**
 * Post a comment on a pull request, optionally anchored inline to a file/line.
 */
export async function postBitbucketComment(
  config: BitbucketConfig,
  prId: number,
  content: string,
  inline?: BitbucketInlineAnchor
): Promise<BitbucketAPIComment> {
  const [workspace, slug] = config.repository.split('/');
  const payload: Record<string, unknown> = { content: { raw: content } };
  if (inline) payload.inline = inline;
  return (await bitbucketFetch(
    config,
    `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}/pullrequests/${prId}/comments`,
    { method: 'POST', body: JSON.stringify(payload) }
  )) as BitbucketAPIComment;
}
