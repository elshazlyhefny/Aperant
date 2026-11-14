/**
 * Build the PR review context (PRContext) for a Bitbucket pull request.
 */

import type { PRContext, ChangedFile } from '../../ai/runners/github/pr-review-engine';
import {
  bitbucketFetch,
  bitbucketFetchText,
  getSafeNextEndpoint
} from './utils';
import type {
  BitbucketConfig,
  BitbucketAPIPullRequest,
  BitbucketAPIPage,
  BitbucketAPIDiffStat,
  BitbucketAPICommit
} from './types';

export const MAX_DIFF_CHARS = 200000;
const MAX_PAGES = 20;
const PAGE_LEN = 100;

export interface BitbucketPRContextResult {
  context: PRContext;
  headSha: string;
  sourceBranch: string;
  sourceRepository?: string;
}

function repoPath(repository: string): string {
  const [workspace, slug] = repository.split('/');
  return `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}`;
}

async function fetchAllPages<T>(
  config: BitbucketConfig,
  firstEndpoint: string
): Promise<T[]> {
  const items: T[] = [];
  let endpoint: string | null = firstEndpoint;
  for (let page = 0; endpoint && page < MAX_PAGES; page += 1) {
    const data = (await bitbucketFetch(config, endpoint)) as BitbucketAPIPage<T>;
    if (Array.isArray(data.values)) items.push(...data.values);
    endpoint = getSafeNextEndpoint(data.next);
  }
  return items;
}

/** Split a unified diff into per-file patches keyed by new (or old) path. */
export function splitDiffByFile(diff: string): Map<string, string> {
  const patches = new Map<string, string>();
  if (!diff) return patches;
  const chunks = diff.split(/^(?=diff --git )/m).filter((c) => c.startsWith('diff --git '));
  for (const chunk of chunks) {
    const header = chunk.split('\n', 1)[0];
    const match = header.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (!match) continue;
    const oldPath = match[1];
    const newPath = match[2];
    patches.set(newPath, chunk);
    if (!patches.has(oldPath)) patches.set(oldPath, chunk);
  }
  return patches;
}

function mapStatus(status: string | undefined): string {
  switch (status) {
    case 'added':
      return 'added';
    case 'removed':
      return 'removed';
    case 'renamed':
      return 'renamed';
    default:
      return 'modified';
  }
}

export async function fetchBitbucketPRContext(
  config: BitbucketConfig,
  prId: number
): Promise<BitbucketPRContextResult> {
  const base = `${repoPath(config.repository)}/pullrequests/${prId}`;

  const pr = (await bitbucketFetch(config, base)) as BitbucketAPIPullRequest;
  const headSha = pr.source?.commit?.hash;
  if (!headSha) {
    throw new Error(`Bitbucket pull request #${prId} has no source commit hash`);
  }

  const rawDiff = await bitbucketFetchText(config, `${base}/diff`);
  const diffTruncated = rawDiff.length > MAX_DIFF_CHARS;
  const diff = diffTruncated ? rawDiff.slice(0, MAX_DIFF_CHARS) : rawDiff;

  const [diffStats, apiCommits] = await Promise.all([
    fetchAllPages<BitbucketAPIDiffStat>(config, `${base}/diffstat?pagelen=${PAGE_LEN}`),
    fetchAllPages<BitbucketAPICommit>(config, `${base}/commits?pagelen=${PAGE_LEN}`)
  ]);

  // Patches come from the full diff so truncation of `diff` does not lose them
  const patches = splitDiffByFile(rawDiff);

  let totalAdditions = 0;
  let totalDeletions = 0;
  const changedFiles: ChangedFile[] = diffStats.map((stat) => {
    const additions = stat.lines_added ?? 0;
    const deletions = stat.lines_removed ?? 0;
    totalAdditions += additions;
    totalDeletions += deletions;
    const filePath = stat.new?.path ?? stat.old?.path ?? '';
    const patch = patches.get(filePath) ?? (stat.old?.path ? patches.get(stat.old.path) : undefined);
    return {
      path: filePath,
      additions,
      deletions,
      status: mapStatus(stat.status),
      ...(patch ? { patch } : {})
    };
  });

  const sourceBranch = pr.source?.branch?.name ?? '';

  const context: PRContext = {
    prNumber: prId,
    title: pr.title ?? '',
    description: pr.description ?? '',
    author: pr.author?.display_name ?? pr.author?.nickname ?? '',
    baseBranch: pr.destination?.branch?.name ?? '',
    headBranch: sourceBranch,
    state: pr.state ?? 'OPEN',
    changedFiles,
    diff,
    diffTruncated,
    repoStructure: '',
    relatedFiles: [],
    commits: apiCommits.map((c) => ({
      oid: c.hash,
      messageHeadline: (c.message ?? '').split('\n', 1)[0],
      committedDate: c.date ?? ''
    })),
    labels: [],
    totalAdditions,
    totalDeletions,
    aiBotComments: []
  };

  return {
    context,
    headSha,
    sourceBranch,
    sourceRepository: pr.source?.repository?.full_name
  };
}
