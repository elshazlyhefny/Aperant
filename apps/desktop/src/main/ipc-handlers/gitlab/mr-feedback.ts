/**
 * zeenha fork: fetch the failing CI jobs and unresolved discussions of a task's
 * GitLab merge request so they can be sent back to the task's agent.
 *
 * GitLab counterpart of github/pr/task-feedback.ts; returns the same
 * PRFeedbackFetchResult shape.
 */

import {
  MAX_FEEDBACK_ITEMS,
  MAX_SUMMARY_LENGTH,
  PRFeedbackError,
  clip,
  clipTail,
  type PRFeedbackFetchResult,
} from '../github/pr/task-feedback';
import { originMatchesInstance } from '../task/worktree-pr';
import { encodeProjectPath, gitlabFetch, gitlabFetchText, GitLabAPIError } from './utils';
import type { GitLabConfig } from './types';
import type { PRFeedbackItem, PRFeedbackResult } from '../../../shared/types/pr-feedback';

const MAX_TITLE_LENGTH = 300;
const MAX_THREAD_NOTES = 5;
const MAX_DISCUSSION_PAGES = 10;
const TRACE_BATCH_SIZE = 5;

/**
 * Parse a merge request URL of the form `/<group>[/<subgroup>...]/<project>/-/merge_requests/<iid>`.
 * Returns null for anything else.
 */
export function parseMergeRequestUrl(
  mrUrl: string
): { iid: number; projectPath: string } | null {
  if (typeof mrUrl !== 'string' || mrUrl.length === 0 || mrUrl.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(mrUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  const match = /^\/((?:[^/]+\/)*[^/]+)\/-\/merge_requests\/(\d{1,9})(?:\/[^/]*)*$/.exec(
    url.pathname
  );
  if (!match) return null;
  const iid = Number.parseInt(match[2], 10);
  if (!(iid > 0)) return null;
  return { iid, projectPath: match[1] };
}

/** Parse the MR iid, requiring the URL to belong to the configured GitLab instance. */
export function parseMRIidFromUrl(mrUrl: string, instanceUrl: string): number | null {
  const parsed = parseMergeRequestUrl(mrUrl);
  if (!parsed) return null;
  return originMatchesInstance(mrUrl.trim(), instanceUrl) ? parsed.iid : null;
}

function mapGitLabError(error: unknown, what: string): PRFeedbackError {
  if (error instanceof PRFeedbackError) return error;
  const status = error instanceof GitLabAPIError ? error.statusCode : 0;
  if (status === 404) return new PRFeedbackError('not_found', `${what} was not found on GitLab`);
  if (status === 401) return new PRFeedbackError('unauthorized', 'GitLab rejected the credentials');
  if (status === 403) {
    return new PRFeedbackError('forbidden', `Access to ${what} was denied (permissions or rate limit)`);
  }
  return new PRFeedbackError('gitlab_error', `Failed to load ${what} from GitLab`);
}

interface RESTMergeRequest {
  state: string;
  web_url?: string;
  source_branch: string;
  sha: string;
  head_pipeline?: { id: number; project_id?: number } | null;
}

interface RESTJob {
  id: number;
  name: string;
  stage?: string;
  status?: string;
  failure_reason?: string | null;
  allow_failure?: boolean;
  web_url?: string;
}

interface RESTNote {
  id: number;
  body?: string | null;
  system?: boolean;
  resolvable?: boolean;
  resolved?: boolean;
  author?: { username?: string } | null;
  position?: {
    new_path?: string | null;
    new_line?: number | null;
    old_path?: string | null;
    old_line?: number | null;
  } | null;
}

interface RESTDiscussion {
  id: string;
  notes?: RESTNote[];
}

async function mapJob(config: GitLabConfig, projectId: string | number, job: RESTJob): Promise<PRFeedbackItem> {
  let raw = '';
  try {
    raw = await gitlabFetchText(
      config.token,
      config.instanceUrl,
      `/projects/${projectId}/jobs/${job.id}/trace`
    );
  } catch {
    // Best effort: fall back to the failure reason below.
  }
  const fallback = job.failure_reason ? `Failure reason: ${job.failure_reason}` : 'Status: failed';
  const body = clipTail(raw.trim() ? raw : fallback, MAX_SUMMARY_LENGTH);
  return {
    id: `check:job-${job.id}`,
    kind: 'check',
    title: clip(`${job.stage ?? 'job'}: ${job.name}`, MAX_TITLE_LENGTH).text,
    summary: body.text,
    url: job.web_url,
    truncated: body.truncated,
  };
}

async function fetchFailedJobs(
  config: GitLabConfig,
  encodedProject: string,
  pipeline: { id: number; project_id?: number }
): Promise<PRFeedbackItem[]> {
  const projectId = pipeline.project_id ?? encodedProject;
  const jobs = (await gitlabFetch(
    config.token,
    config.instanceUrl,
    `/projects/${projectId}/pipelines/${pipeline.id}/jobs?scope%5B%5D=failed&per_page=100`
  )) as RESTJob[];

  const failed = (Array.isArray(jobs) ? jobs : [])
    .filter((j) => !j.allow_failure)
    .slice(0, MAX_FEEDBACK_ITEMS);

  const items: PRFeedbackItem[] = [];
  for (let i = 0; i < failed.length; i += TRACE_BATCH_SIZE) {
    const batch = failed.slice(i, i + TRACE_BATCH_SIZE);
    items.push(...(await Promise.all(batch.map((j) => mapJob(config, projectId, j)))));
  }
  return items;
}

async function fetchUnresolvedDiscussions(
  config: GitLabConfig,
  encodedProject: string,
  iid: number,
  webUrl: string
): Promise<PRFeedbackItem[]> {
  const items: PRFeedbackItem[] = [];
  for (let page = 1; page <= MAX_DISCUSSION_PAGES && items.length < MAX_FEEDBACK_ITEMS; page++) {
    const discussions = (await gitlabFetch(
      config.token,
      config.instanceUrl,
      `/projects/${encodedProject}/merge_requests/${iid}/discussions?per_page=100&page=${page}`
    )) as RESTDiscussion[];
    if (!Array.isArray(discussions) || discussions.length === 0) break;

    for (const d of discussions) {
      const notes = (d.notes ?? []).filter((n) => !n.system);
      const first = notes[0];
      if (!first || !first.resolvable || first.resolved) continue;

      const rendered = notes
        .slice(0, MAX_THREAD_NOTES)
        .map((n) => `${n.author?.username ?? 'unknown'}: ${(n.body ?? '').trim()}`)
        .join('\n\n');
      const body = clip(rendered, MAX_SUMMARY_LENGTH);
      const path = first.position?.new_path ?? first.position?.old_path ?? undefined;
      const line = first.position?.new_line ?? first.position?.old_line ?? undefined;
      const location = path ? `${path}${line ? `:${line}` : ''}` : 'Review thread';
      items.push({
        id: `thread:${d.id}`,
        kind: 'review_thread',
        title: clip(location, MAX_TITLE_LENGTH).text,
        summary: body.text,
        url: `${webUrl}#note_${first.id}`,
        path,
        line,
        author: first.author?.username,
        truncated: body.truncated,
      });
      if (items.length >= MAX_FEEDBACK_ITEMS) break;
    }

    if (discussions.length < 100) break;
  }
  return items;
}

/**
 * Fetch failing CI jobs and unresolved discussions for a merge request.
 * @throws PRFeedbackError for invalid project, 401/403/404, and other GitLab failures.
 */
export async function fetchMRFeedback(
  config: GitLabConfig,
  iid: number
): Promise<PRFeedbackFetchResult> {
  if (typeof config.project !== 'string' || !config.project.trim()) {
    throw new PRFeedbackError('invalid_repo', 'GitLab project is not configured correctly');
  }
  if (!Number.isInteger(iid) || iid <= 0) {
    throw new PRFeedbackError('not_found', 'Invalid merge request number');
  }
  const encoded = encodeProjectPath(config.project);

  try {
    const mr = (await gitlabFetch(
      config.token,
      config.instanceUrl,
      `/projects/${encoded}/merge_requests/${iid}`
    )) as RESTMergeRequest;

    const prState: PRFeedbackResult['prState'] =
      mr.state === 'merged' ? 'merged' : mr.state === 'opened' ? 'open' : 'closed';
    const prUrl =
      mr.web_url ??
      `${config.instanceUrl.replace(/\/+$/, '')}/${config.project}/-/merge_requests/${iid}`;

    const pipeline = mr.head_pipeline;
    const [checks, threads] = await Promise.all([
      pipeline?.id ? fetchFailedJobs(config, encoded, pipeline) : Promise.resolve([]),
      fetchUnresolvedDiscussions(config, encoded, iid, prUrl),
    ]);

    return {
      prNumber: iid,
      prUrl,
      prState,
      headRef: mr.source_branch,
      headSha: mr.sha,
      checks,
      threads,
      reviews: [],
    };
  } catch (error) {
    throw mapGitLabError(error, `merge request !${iid}`);
  }
}
