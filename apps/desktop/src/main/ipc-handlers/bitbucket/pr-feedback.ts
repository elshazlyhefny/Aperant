/**
 * zeenha fork: fetch the failed Bitbucket Pipelines steps and unresolved
 * comment threads of a task's pull request so they can be sent back to the
 * task's agent.
 *
 * Bitbucket counterpart of gitlab/mr-feedback.ts; returns the same
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
import { bitbucketFetch, bitbucketFetchLog, BitbucketAPIError, getSafeNextEndpoint } from './utils';
import type {
  BitbucketAPIComment,
  BitbucketAPIPage,
  BitbucketAPIPipeline,
  BitbucketAPIPipelineStep,
  BitbucketAPIPullRequest,
  BitbucketConfig,
} from './types';
import type { PRFeedbackItem, PRFeedbackResult } from '../../../shared/types/pr-feedback';

const MAX_TITLE_LENGTH = 300;
const MAX_THREAD_COMMENTS = 5;
const MAX_COMMENT_PAGES = 10;
const LOG_BATCH_SIZE = 5;
/** Bytes read from the end of a step log. */
const LOG_TAIL_BYTES = 65536;
const FAILED_RESULTS = new Set(['FAILED', 'ERROR']);

/**
 * Parse a pull request URL of the form
 * `https://bitbucket.org/<workspace>/<repo>/pull-requests/<id>[/...]`.
 * Returns null for anything else.
 */
export function parseBitbucketPullRequestUrl(
  prUrl: string
): { id: number; workspace: string; repoSlug: string } | null {
  if (typeof prUrl !== 'string' || prUrl.length === 0 || prUrl.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(prUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'bitbucket.org') return null;
  if (url.username || url.password) return null;
  const match = /^\/([^/]+)\/([^/]+)\/pull-requests\/(\d{1,9})(?:\/[^/]*)*$/.exec(url.pathname);
  if (!match) return null;
  const id = Number.parseInt(match[3], 10);
  if (!(id > 0)) return null;
  return { id, workspace: match[1], repoSlug: match[2] };
}

/** Parse the pull request id from a Bitbucket PR URL, or null. */
export function parseBitbucketPRIdFromUrl(prUrl: string): number | null {
  return parseBitbucketPullRequestUrl(prUrl)?.id ?? null;
}

function mapBitbucketError(error: unknown, what: string): PRFeedbackError {
  if (error instanceof PRFeedbackError) return error;
  const status = error instanceof BitbucketAPIError ? error.statusCode : 0;
  if (status === 404) return new PRFeedbackError('not_found', `${what} was not found on Bitbucket`);
  if (status === 401) return new PRFeedbackError('unauthorized', 'Bitbucket rejected the credentials');
  if (status === 403) {
    return new PRFeedbackError('forbidden', `Access to ${what} was denied (permissions or rate limit)`);
  }
  return new PRFeedbackError('bitbucket_error', `Failed to load ${what} from Bitbucket`);
}

const stripBraces = (uuid: string): string => uuid.replace(/[{}]/g, '');

async function findPipeline(
  config: BitbucketConfig,
  headSha: string | undefined,
  headRef: string | undefined
): Promise<BitbucketAPIPipeline | null> {
  let page: BitbucketAPIPage<BitbucketAPIPipeline>;
  try {
    page = (await bitbucketFetch(
      config,
      `/repositories/${config.repository}/pipelines/?sort=-created_on&pagelen=100`
    )) as BitbucketAPIPage<BitbucketAPIPipeline>;
  } catch (error) {
    // Pipelines disabled for the repository: no checks, not an error.
    if (error instanceof BitbucketAPIError && error.statusCode === 404) return null;
    throw error;
  }
  const pipelines = Array.isArray(page?.values) ? page.values : [];
  if (headSha) {
    const byCommit = pipelines.find((p) => {
      const hash = p.target?.commit?.hash;
      return !!hash && (hash.startsWith(headSha) || headSha.startsWith(hash));
    });
    if (byCommit) return byCommit;
  }
  if (headRef) {
    return pipelines.find((p) => p.target?.ref_name === headRef) ?? null;
  }
  return null;
}

async function mapStep(
  config: BitbucketConfig,
  pipeline: BitbucketAPIPipeline,
  step: BitbucketAPIPipelineStep
): Promise<PRFeedbackItem> {
  let raw = '';
  try {
    raw = await bitbucketFetchLog(
      config,
      `/repositories/${config.repository}/pipelines/${encodeURIComponent(pipeline.uuid)}/steps/${encodeURIComponent(step.uuid)}/log`,
      { range: `bytes=-${LOG_TAIL_BYTES}` }
    );
  } catch {
    // Best effort: fall back to the result name below.
  }
  const resultName = step.state?.result?.name ?? 'FAILED';
  const body = clipTail(raw.trim() ? raw : `Status: ${resultName}`, MAX_SUMMARY_LENGTH);
  const buildRef = pipeline.build_number ?? stripBraces(pipeline.uuid);
  return {
    id: `check:step-${buildRef}-${stripBraces(step.uuid)}`,
    kind: 'check',
    title: clip(step.name ?? 'Pipeline step', MAX_TITLE_LENGTH).text,
    summary: body.text,
    url:
      pipeline.build_number !== undefined
        ? `https://bitbucket.org/${config.repository}/pipelines/results/${pipeline.build_number}`
        : undefined,
    truncated: body.truncated,
  };
}

async function fetchFailedSteps(
  config: BitbucketConfig,
  headSha: string | undefined,
  headRef: string | undefined
): Promise<PRFeedbackItem[]> {
  const pipeline = await findPipeline(config, headSha, headRef);
  if (!pipeline?.uuid) return [];

  let stepsPage: BitbucketAPIPage<BitbucketAPIPipelineStep>;
  try {
    stepsPage = (await bitbucketFetch(
      config,
      `/repositories/${config.repository}/pipelines/${encodeURIComponent(pipeline.uuid)}/steps/?pagelen=100`
    )) as BitbucketAPIPage<BitbucketAPIPipelineStep>;
  } catch (error) {
    if (error instanceof BitbucketAPIError && error.statusCode === 404) return [];
    throw error;
  }

  const failed = (Array.isArray(stepsPage?.values) ? stepsPage.values : [])
    .filter((s) => s.uuid && FAILED_RESULTS.has(s.state?.result?.name ?? ''))
    .slice(0, MAX_FEEDBACK_ITEMS);

  const items: PRFeedbackItem[] = [];
  for (let i = 0; i < failed.length; i += LOG_BATCH_SIZE) {
    const batch = failed.slice(i, i + LOG_BATCH_SIZE);
    items.push(...(await Promise.all(batch.map((s) => mapStep(config, pipeline, s)))));
  }
  return items;
}

async function fetchUnresolvedThreads(
  config: BitbucketConfig,
  id: number
): Promise<PRFeedbackItem[]> {
  const comments: BitbucketAPIComment[] = [];
  let endpoint: string | null = `/repositories/${config.repository}/pullrequests/${id}/comments?pagelen=100`;
  for (let page = 0; page < MAX_COMMENT_PAGES && endpoint; page++) {
    const result = (await bitbucketFetch(config, endpoint)) as BitbucketAPIPage<BitbucketAPIComment>;
    if (Array.isArray(result?.values)) comments.push(...result.values);
    endpoint = getSafeNextEndpoint(result?.next);
  }

  const byId = new Map<number, BitbucketAPIComment>();
  for (const c of comments) byId.set(c.id, c);
  const rootOf = (c: BitbucketAPIComment): number => {
    let current = c;
    for (let depth = 0; current.parent && depth < 50; depth++) {
      const parent = byId.get(current.parent.id);
      if (!parent) return current.parent.id;
      current = parent;
    }
    return current.id;
  };

  const replies = new Map<number, BitbucketAPIComment[]>();
  for (const c of comments) {
    if (!c.parent || c.deleted) continue;
    const root = rootOf(c);
    const list = replies.get(root) ?? [];
    list.push(c);
    replies.set(root, list);
  }

  const items: PRFeedbackItem[] = [];
  for (const root of comments) {
    if (root.parent || root.deleted || root.resolution) continue;
    const thread = [root, ...(replies.get(root.id) ?? [])].slice(0, MAX_THREAD_COMMENTS);
    const rendered = thread
      .map((c) => `${c.user?.display_name ?? c.user?.nickname ?? 'unknown'}: ${(c.content?.raw ?? '').trim()}`)
      .join('\n\n');
    const body = clip(rendered, MAX_SUMMARY_LENGTH);
    const path = root.inline?.path || undefined;
    const line = root.inline ? (root.inline.to ?? root.inline.from ?? undefined) : undefined;
    const location = path ? `${path}${line ? `:${line}` : ''}` : 'Review thread';
    items.push({
      id: `thread:${root.id}`,
      kind: 'review_thread',
      title: clip(location, MAX_TITLE_LENGTH).text,
      summary: body.text,
      url: root.links?.html?.href,
      path,
      line,
      author: root.user?.display_name ?? root.user?.nickname,
      truncated: body.truncated,
    });
    if (items.length >= MAX_FEEDBACK_ITEMS) break;
  }
  return items;
}

/**
 * Fetch failed Pipelines steps and unresolved comment threads for a pull request.
 * @throws PRFeedbackError for invalid repo, 401/403/404, and other Bitbucket failures.
 */
export async function fetchBitbucketPRFeedback(
  config: BitbucketConfig,
  id: number
): Promise<PRFeedbackFetchResult> {
  if (typeof config.repository !== 'string' || !config.repository.includes('/')) {
    throw new PRFeedbackError('invalid_repo', 'Bitbucket repository is not configured correctly');
  }
  if (!Number.isInteger(id) || id <= 0) {
    throw new PRFeedbackError('not_found', 'Invalid pull request number');
  }

  try {
    const pr = (await bitbucketFetch(
      config,
      `/repositories/${config.repository}/pullrequests/${id}`
    )) as BitbucketAPIPullRequest;

    const state = (pr.state ?? '').toUpperCase();
    const prState: PRFeedbackResult['prState'] =
      state === 'MERGED' ? 'merged' : state === 'OPEN' ? 'open' : 'closed';
    const prUrl =
      pr.links?.html?.href ?? `https://bitbucket.org/${config.repository}/pull-requests/${id}`;
    const headRef = pr.source?.branch?.name ?? '';
    const headSha = pr.source?.commit?.hash ?? '';

    const [checks, threads] = await Promise.all([
      fetchFailedSteps(config, headSha || undefined, headRef || undefined),
      fetchUnresolvedThreads(config, id),
    ]);

    return { prNumber: id, prUrl, prState, headRef, headSha, checks, threads, reviews: [] };
  } catch (error) {
    throw mapBitbucketError(error, `pull request #${id}`);
  }
}
