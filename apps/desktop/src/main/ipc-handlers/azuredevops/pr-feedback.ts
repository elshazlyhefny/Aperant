/**
 * zeenha fork: fetch the failing build validations and active comment threads
 * of a task's Azure DevOps pull request so they can be sent back to the task's agent.
 *
 * Azure DevOps counterpart of gitlab/mr-feedback.ts; returns the same
 * PRFeedbackFetchResult shape.
 */

import {
  MAX_FEEDBACK_ITEMS,
  MAX_SUMMARY_LENGTH,
  PRFeedbackError,
  clip,
  clipTail,
  redactSecrets,
  type PRFeedbackFetchResult,
} from '../github/pr/task-feedback';
import { azureDevOpsFetch, azureDevOpsFetchText, AzureDevOpsAPIError } from './utils';
import type { AzureDevOpsConfig, AzureDevOpsRepoRef } from './types';
import type { PRFeedbackItem, PRFeedbackResult } from '../../../shared/types/pr-feedback';

const MAX_TITLE_LENGTH = 300;
const MAX_THREAD_COMMENTS = 5;
const LOG_BATCH_SIZE = 5;
const POLICY_API_VERSION = '7.1-preview.1';

export interface AzureDevOpsPullRequestRef extends AzureDevOpsRepoRef {
  id: number;
}

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value) || null;
  } catch {
    return null;
  }
}

/**
 * Parse an Azure DevOps pull request URL:
 * https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}
 * https://{org}.visualstudio.com/{project}/_git/{repo}/pullrequest/{id}
 * Returns null for anything else.
 */
export function parseAzureDevOpsPullRequestUrl(prUrl: string): AzureDevOpsPullRequestRef | null {
  if (typeof prUrl !== 'string' || prUrl.length === 0 || prUrl.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(prUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;

  const host = url.hostname.toLowerCase();
  let organization: string | null = null;
  let rest: string;
  if (host === 'dev.azure.com') {
    const m = /^\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (!m) return null;
    organization = decode(m[1]);
    rest = m[2];
  } else {
    const m = /^([a-z0-9][a-z0-9-]*)\.visualstudio\.com$/.exec(host);
    if (!m) return null;
    organization = m[1];
    rest = url.pathname.replace(/^\//, '');
  }

  const parts = /^([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d{1,9})(?:\/.*)?$/.exec(rest);
  if (!organization || !parts) return null;
  const project = decode(parts[1]);
  const repository = decode(parts[2]);
  const id = Number.parseInt(parts[3], 10);
  if (!project || !repository || !(id > 0)) return null;
  return { organization, project, repository, id };
}

/**
 * Parse the PR id, requiring the URL to belong to the configured
 * organization, project and repository (case-insensitive).
 */
export function parseAzureDevOpsPRIdFromUrl(
  prUrl: string,
  config: Pick<AzureDevOpsConfig, 'organization' | 'project' | 'repository'>
): number | null {
  const parsed = parseAzureDevOpsPullRequestUrl(prUrl);
  if (!parsed) return null;
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (
    eq(parsed.organization, config.organization) &&
    eq(parsed.project, config.project) &&
    eq(parsed.repository, config.repository)
  ) {
    return parsed.id;
  }
  return null;
}

function mapAzureError(error: unknown, what: string): PRFeedbackError {
  if (error instanceof PRFeedbackError) return error;
  const status = error instanceof AzureDevOpsAPIError ? error.statusCode : 0;
  if (status === 404) return new PRFeedbackError('not_found', `${what} was not found on Azure DevOps`);
  if (status === 401) return new PRFeedbackError('unauthorized', 'Azure DevOps rejected the credentials');
  if (status === 403) {
    return new PRFeedbackError('forbidden', `Access to ${what} was denied (permissions or rate limit)`);
  }
  return new PRFeedbackError('azuredevops_error', `Failed to load ${what} from Azure DevOps`);
}

interface RESTPullRequest {
  status?: string;
  sourceRefName?: string;
  lastMergeSourceCommit?: { commitId?: string };
  repository?: { project?: { id?: string } };
}

interface RESTEvaluation {
  status?: string;
  configuration?: { type?: { displayName?: string } };
  context?: { buildId?: number; buildDefinitionId?: number } | null;
}

interface RESTTimelineRecord {
  id?: string;
  name?: string;
  type?: string;
  result?: string;
  log?: { id?: number; url?: string } | null;
}

interface RESTBuild {
  buildNumber?: string;
  definition?: { name?: string };
}

interface RESTThreadComment {
  content?: string | null;
  commentType?: string;
  author?: { displayName?: string; uniqueName?: string } | null;
}

interface RESTThread {
  id: number;
  status?: string;
  isDeleted?: boolean;
  comments?: RESTThreadComment[];
  threadContext?: { filePath?: string; rightFileStart?: { line?: number } } | null;
}

function buildResultUrl(config: AzureDevOpsConfig, buildId: number): string {
  return (
    `https://dev.azure.com/${encodeURIComponent(config.organization)}` +
    `/${encodeURIComponent(config.project)}/_build/results?buildId=${buildId}`
  );
}

function repoPrefix(config: AzureDevOpsConfig): string {
  return `/git/repositories/${encodeURIComponent(config.repository)}`;
}

async function readLog(config: AzureDevOpsConfig, buildId: number, record: RESTTimelineRecord): Promise<string> {
  const logId = record.log?.id;
  let endpoint: string | null = null;
  if (typeof logId === 'number') {
    endpoint = `/build/builds/${buildId}/logs/${logId}`;
  } else if (record.log?.url) {
    try {
      const u = new URL(record.log.url);
      const idx = u.pathname.indexOf('/_apis/');
      if (u.hostname.toLowerCase() === 'dev.azure.com' && idx >= 0) {
        endpoint = u.pathname.slice(idx + '/_apis'.length);
      }
    } catch {
      endpoint = null;
    }
  }
  if (!endpoint) return '';
  try {
    return await azureDevOpsFetchText(config, endpoint);
  } catch {
    return '';
  }
}

async function fetchFailedBuildItems(
  config: AzureDevOpsConfig,
  projectId: string,
  prId: number
): Promise<PRFeedbackItem[]> {
  const artifact = `vstfs:///CodeReview/CodeReviewId/${projectId}/${prId}`;
  const evaluations = (await azureDevOpsFetch(
    config,
    `/policy/evaluations?artifactId=${encodeURIComponent(artifact)}&api-version=${POLICY_API_VERSION}`
  )) as { value?: RESTEvaluation[] };

  const buildIds: number[] = [];
  for (const e of evaluations.value ?? []) {
    if (e.configuration?.type?.displayName !== 'Build') continue;
    if (e.status !== 'rejected' && e.status !== 'broken') continue;
    const buildId = e.context?.buildId;
    if (typeof buildId === 'number' && !buildIds.includes(buildId)) buildIds.push(buildId);
  }

  const items: PRFeedbackItem[] = [];
  for (const buildId of buildIds) {
    if (items.length >= MAX_FEEDBACK_ITEMS) break;
    const [build, timeline] = await Promise.all([
      azureDevOpsFetch(config, `/build/builds/${buildId}`).catch(() => ({}) as RESTBuild) as Promise<RESTBuild>,
      azureDevOpsFetch(config, `/build/builds/${buildId}/timeline`) as Promise<{ records?: RESTTimelineRecord[] }>,
    ]);
    const buildName = build.definition?.name ?? build.buildNumber ?? `build ${buildId}`;
    const failed = (timeline.records ?? [])
      .filter((r) => (r.type === 'Task' || r.type === 'Job') && r.result === 'failed')
      .slice(0, MAX_FEEDBACK_ITEMS - items.length);

    for (let i = 0; i < failed.length; i += LOG_BATCH_SIZE) {
      const batch = failed.slice(i, i + LOG_BATCH_SIZE);
      const mapped = await Promise.all(
        batch.map(async (record): Promise<PRFeedbackItem> => {
          const raw = await readLog(config, buildId, record);
          const body = clipTail(redactSecrets(raw.trim() ? raw : 'Status: failed'), MAX_SUMMARY_LENGTH);
          return {
            id: `check:build-${buildId}-${record.id ?? record.name ?? 'record'}`.replace(/[^A-Za-z0-9_\-=:.]/g, '_'),
            kind: 'check',
            title: clip(`${buildName} / ${record.name ?? 'unnamed'}`, MAX_TITLE_LENGTH).text,
            summary: body.text,
            url: buildResultUrl(config, buildId),
            truncated: body.truncated,
          };
        })
      );
      items.push(...mapped);
    }
  }
  return items.slice(0, MAX_FEEDBACK_ITEMS);
}

async function fetchActiveThreads(
  config: AzureDevOpsConfig,
  prId: number,
  prUrl: string
): Promise<PRFeedbackItem[]> {
  const result = (await azureDevOpsFetch(config, `${repoPrefix(config)}/pullrequests/${prId}/threads`)) as {
    value?: RESTThread[];
  };
  const items: PRFeedbackItem[] = [];
  for (const t of result.value ?? []) {
    if (t.status !== 'active' && t.status !== 'pending') continue;
    if (t.isDeleted) continue;
    const comments = (t.comments ?? []).filter((c) => c.commentType !== 'system');
    const first = comments[0];
    if (!first) continue;

    const rendered = comments
      .slice(0, MAX_THREAD_COMMENTS)
      .map((c) => `${c.author?.displayName ?? c.author?.uniqueName ?? 'unknown'}: ${(c.content ?? '').trim()}`)
      .join('\n\n');
    const body = clip(rendered, MAX_SUMMARY_LENGTH);
    const path = t.threadContext?.filePath || undefined;
    const line = t.threadContext?.rightFileStart?.line || undefined;
    const location = path ? `${path}${line ? `:${line}` : ''}` : 'Review thread';
    items.push({
      id: `thread:${t.id}`,
      kind: 'review_thread',
      title: clip(location, MAX_TITLE_LENGTH).text,
      summary: body.text,
      url: `${prUrl}?discussionId=${t.id}`,
      path,
      line,
      author: first.author?.displayName ?? first.author?.uniqueName,
      truncated: body.truncated,
    });
    if (items.length >= MAX_FEEDBACK_ITEMS) break;
  }
  return items;
}

/**
 * Fetch failing build validations and active threads for a pull request.
 * @throws PRFeedbackError for invalid config, 401/403/404, and other Azure DevOps failures.
 */
export async function fetchAzureDevOpsPRFeedback(
  config: AzureDevOpsConfig,
  prId: number
): Promise<PRFeedbackFetchResult> {
  if (!config.organization || !config.project || !config.repository) {
    throw new PRFeedbackError('invalid_repo', 'Azure DevOps repository is not configured correctly');
  }
  if (!Number.isInteger(prId) || prId <= 0) {
    throw new PRFeedbackError('not_found', 'Invalid pull request number');
  }

  try {
    const pr = (await azureDevOpsFetch(config, `${repoPrefix(config)}/pullrequests/${prId}`)) as RESTPullRequest;
    const prState: PRFeedbackResult['prState'] =
      pr.status === 'active' ? 'open' : pr.status === 'completed' ? 'merged' : 'closed';
    const prUrl =
      `https://dev.azure.com/${encodeURIComponent(config.organization)}` +
      `/${encodeURIComponent(config.project)}/_git/${encodeURIComponent(config.repository)}/pullrequest/${prId}`;
    const projectId = pr.repository?.project?.id;

    const [checks, threads] = await Promise.all([
      projectId ? fetchFailedBuildItems(config, projectId, prId) : Promise.resolve([]),
      fetchActiveThreads(config, prId, prUrl),
    ]);

    return {
      prNumber: prId,
      prUrl,
      prState,
      headRef: (pr.sourceRefName ?? '').replace(/^refs\/heads\//, ''),
      headSha: pr.lastMergeSourceCommit?.commitId ?? '',
      checks,
      threads,
      reviews: [],
    };
  } catch (error) {
    throw mapAzureError(error, `pull request !${prId}`);
  }
}
