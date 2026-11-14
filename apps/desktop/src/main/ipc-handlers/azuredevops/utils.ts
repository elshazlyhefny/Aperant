/**
 * Azure DevOps utility functions
 */

import { readFile, access } from 'fs/promises';
import { execFileSync } from 'child_process';
import path from 'path';
import type { Project } from '../../../shared/types';
import { parseEnvFile } from '../utils';
import type {
  AzureDevOpsConfig,
  AzureDevOpsAPIPullRequest,
  AzureDevOpsAPIPage,
  AzureDevOpsRepoRef
} from './types';
import { getIsolatedGitEnv } from '../../utils/git-isolation';

export const AZURE_DEVOPS_API_BASE = 'https://dev.azure.com';
export const AZURE_DEVOPS_API_VERSION = '7.1';

// Default timeout for Azure DevOps API requests (30 seconds)
export const AZURE_DEVOPS_API_TIMEOUT_MS = 30000;

const MAX_PAT_LENGTH = 512;
const MAX_NAME_LENGTH = 256;
const MAX_ERROR_BODY_LENGTH = 500;

const ORGANIZATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Azure DevOps environment variable keys (must match env-handlers.ts)
const AZURE_DEVOPS_ENV_KEYS = {
  ENABLED: 'AZURE_DEVOPS_ENABLED',
  ORGANIZATION: 'AZURE_DEVOPS_ORGANIZATION',
  PROJECT: 'AZURE_DEVOPS_PROJECT',
  REPOSITORY: 'AZURE_DEVOPS_REPOSITORY',
  PAT: 'AZURE_DEVOPS_PAT'
} as const;

/**
 * Custom error class for Azure DevOps API errors with structured status code
 */
export class AzureDevOpsAPIError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'AzureDevOpsAPIError';
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

function hasControlChars(value: string): boolean {
  return stripControlChars(value) !== value;
}

export function sanitizePat(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = stripControlChars(value).trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_PAT_LENGTH ? trimmed.substring(0, MAX_PAT_LENGTH) : trimmed;
}

export function sanitizeOrganization(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = stripControlChars(value).trim();
  if (!trimmed || trimmed.length > MAX_NAME_LENGTH) return null;
  return ORGANIZATION_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * Sanitize a project or repository name. Spaces are allowed; '/' and control chars are not.
 */
export function sanitizeName(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = stripControlChars(value).trim();
  if (!trimmed || trimmed.length > MAX_NAME_LENGTH) return null;
  if (trimmed.includes('/') || hasControlChars(trimmed)) return null;
  return trimmed;
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
 * Get Azure DevOps configuration from the project environment file.
 * Returns null if disabled via AZURE_DEVOPS_ENABLED=false or incomplete.
 */
export async function getAzureDevOpsConfig(project: Project): Promise<AzureDevOpsConfig | null> {
  if (!project.autoBuildPath) return null;
  const envPath = path.join(project.path, project.autoBuildPath, '.env');
  if (!(await fileExists(envPath))) return null;

  try {
    const content = await readFile(envPath, 'utf-8');
    const vars = parseEnvFile(content);

    if (vars[AZURE_DEVOPS_ENV_KEYS.ENABLED]?.toLowerCase() === 'false') {
      return null;
    }

    const organization = sanitizeOrganization(vars[AZURE_DEVOPS_ENV_KEYS.ORGANIZATION]);
    const projectName = sanitizeName(vars[AZURE_DEVOPS_ENV_KEYS.PROJECT]);
    const repository = sanitizeName(vars[AZURE_DEVOPS_ENV_KEYS.REPOSITORY]);
    const pat = sanitizePat(vars[AZURE_DEVOPS_ENV_KEYS.PAT]);

    if (!organization || !projectName || !repository || !pat) return null;
    return { organization, project: projectName, repository, pat };
  } catch {
    return null;
  }
}

function buildUrl(config: Pick<AzureDevOpsConfig, 'organization' | 'project'>, endpoint: string): string {
  if (typeof endpoint !== 'string' || !endpoint.startsWith('/') || endpoint.startsWith('//')) {
    throw new Error('Azure DevOps endpoint must be a relative path');
  }
  const base =
    `${AZURE_DEVOPS_API_BASE}/${encodeURIComponent(config.organization)}` +
    `/${encodeURIComponent(config.project)}/_apis`;
  const hashless = endpoint.split('#')[0];
  const separator = hashless.includes('?') ? '&' : '?';
  return `${base}${hashless}${separator}api-version=${AZURE_DEVOPS_API_VERSION}`;
}

/** Basic auth header value: empty username, PAT as password */
export function buildAuthHeader(pat: string): string {
  return `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
}

async function azureDevOpsRequest(
  config: Pick<AzureDevOpsConfig, 'organization' | 'project' | 'pat'>,
  endpoint: string,
  options: RequestInit,
  accept: string
): Promise<Response> {
  const url = buildUrl(config, endpoint);
  const pat = sanitizePat(config.pat);
  if (!pat) {
    throw new Error('Invalid Azure DevOps credentials');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AZURE_DEVOPS_API_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
        Accept: accept,
        Authorization: buildAuthHeader(pat)
      }
    });

    if (!response.ok) {
      // Only status and clipped body are surfaced; request headers never appear in errors
      const errorBody = await response.text().catch(() => '');
      throw new AzureDevOpsAPIError(
        `Azure DevOps API error: ${response.status} ${response.statusText}${errorBody ? ` - ${errorBody.substring(0, MAX_ERROR_BODY_LENGTH)}` : ''}`,
        response.status
      );
    }
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AzureDevOpsAPIError(
        `Azure DevOps API timeout after ${AZURE_DEVOPS_API_TIMEOUT_MS / 1000}s: ${endpoint}`,
        0
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Make a JSON request to the Azure DevOps API with timeout
 */
export async function azureDevOpsFetch(
  config: Pick<AzureDevOpsConfig, 'organization' | 'project' | 'pat'>,
  endpoint: string,
  options: RequestInit = {}
): Promise<unknown> {
  const response = await azureDevOpsRequest(config, endpoint, options, 'application/json');
  return response.json();
}

/**
 * Make a request returning plain text (used for build logs)
 */
export async function azureDevOpsFetchText(
  config: Pick<AzureDevOpsConfig, 'organization' | 'project' | 'pat'>,
  endpoint: string,
  options: RequestInit = {}
): Promise<string> {
  const response = await azureDevOpsRequest(config, endpoint, options, 'text/plain');
  return response.text();
}

function repoEndpoint(config: AzureDevOpsConfig, suffix: string): string {
  return `/git/repositories/${encodeURIComponent(config.repository)}${suffix}`;
}

/**
 * Create a pull request from sourceBranch into targetBranch.
 */
export async function createAzureDevOpsPullRequest(
  config: AzureDevOpsConfig,
  params: { sourceBranch: string; targetBranch: string; title: string; description: string; isDraft: boolean }
): Promise<AzureDevOpsAPIPullRequest> {
  return (await azureDevOpsFetch(config, repoEndpoint(config, '/pullrequests'), {
    method: 'POST',
    body: JSON.stringify({
      sourceRefName: `refs/heads/${params.sourceBranch}`,
      targetRefName: `refs/heads/${params.targetBranch}`,
      title: params.title,
      description: params.description,
      isDraft: params.isDraft
    })
  })) as AzureDevOpsAPIPullRequest;
}

/**
 * Web URL of a pull request.
 */
export function buildPullRequestWebUrl(config: AzureDevOpsConfig, id: number): string {
  return (
    `${AZURE_DEVOPS_API_BASE}/${encodeURIComponent(config.organization)}` +
    `/${encodeURIComponent(config.project)}/_git/${encodeURIComponent(config.repository)}` +
    `/pullrequest/${encodeURIComponent(String(id))}`
  );
}

/**
 * Find an active pull request whose source branch is `sourceBranch`, or null.
 */
export async function findOpenPullRequestForBranch(
  config: AzureDevOpsConfig,
  sourceBranch: string
): Promise<AzureDevOpsAPIPullRequest | null> {
  const ref = encodeURIComponent(`refs/heads/${sourceBranch}`);
  const page = (await azureDevOpsFetch(
    config,
    repoEndpoint(config, `/pullrequests?searchCriteria.status=active&searchCriteria.sourceRefName=${ref}&$top=1`)
  )) as AzureDevOpsAPIPage<AzureDevOpsAPIPullRequest>;
  return page.value?.[0] ?? null;
}

function decodeSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded || null;
  } catch {
    return null;
  }
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/, '');
}

function toRepoRef(org: string, project: string, repo: string): AzureDevOpsRepoRef | null {
  const o = decodeSegment(org);
  const p = decodeSegment(project);
  const r = decodeSegment(stripGitSuffix(repo));
  if (!o || !p || !r) return null;
  return { organization: o, project: p, repository: r };
}

/**
 * Parse an Azure DevOps remote URL. Returns null for anything else.
 */
export function parseAzureDevOpsRemoteUrl(remoteUrl: string): AzureDevOpsRepoRef | null {
  if (!remoteUrl) return null;
  const url = remoteUrl.trim();

  let m = url.match(/^https:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+?)\/?$/);
  if (m) return toRepoRef(m[1], m[2], m[3]);

  m = url.match(/^(?:ssh:\/\/)?git@ssh\.dev\.azure\.com[:/]v3\/([^/]+)\/([^/]+)\/([^/]+?)\/?$/);
  if (m) return toRepoRef(m[1], m[2], m[3]);

  m = url.match(
    /^https:\/\/(?:[^@/]+@)?([^./@]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/]+?)\/?$/
  );
  if (m) return toRepoRef(m[1], m[2], m[3]);

  m = url.match(/^(?:ssh:\/\/)?[^@/]+@vs-ssh\.visualstudio\.com[:/]v3\/([^/]+)\/([^/]+)\/([^/]+?)\/?$/);
  if (m) return toRepoRef(m[1], m[2], m[3]);

  return null;
}

/**
 * Detect Azure DevOps repository from the git origin remote URL
 */
export function detectAzureDevOpsRepositoryFromRemote(
  projectPath: string
): (AzureDevOpsRepoRef & { fullName: string }) | null {
  try {
    const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: 'pipe',
      env: getIsolatedGitEnv()
    }).trim();

    const parsed = parseAzureDevOpsRemoteUrl(remoteUrl);
    if (!parsed) return null;
    return { ...parsed, fullName: `${parsed.organization}/${parsed.project}/${parsed.repository}` };
  } catch {
    return null;
  }
}

/**
 * Case-insensitive check that a remote URL points at the configured repository.
 */
export function azureDevOpsRemoteMatchesConfig(
  remoteUrl: string,
  config: Pick<AzureDevOpsConfig, 'organization' | 'project' | 'repository'>
): boolean {
  const parsed = parseAzureDevOpsRemoteUrl(remoteUrl);
  if (!parsed) return false;
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  return (
    eq(parsed.organization, config.organization) &&
    eq(parsed.project, config.project) &&
    eq(parsed.repository, config.repository)
  );
}
