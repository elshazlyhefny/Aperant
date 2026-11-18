/**
 * Build the PR review context (PRContext) for an Azure DevOps pull request.
 *
 * zeenha fork: Azure DevOps has no unified-diff endpoint, so the diff is built
 * from iteration changes plus the file contents at the base and head commits.
 */

import type { PRContext, ChangedFile } from '../../ai/runners/github/pr-review-engine';
import { azureDevOpsFetch, azureDevOpsFetchText, AzureDevOpsAPIError } from './utils';
import type {
  AzureDevOpsConfig,
  AzureDevOpsAPIPullRequest,
  AzureDevOpsAPIPage,
  AzureDevOpsAPIIteration,
  AzureDevOpsAPIChange,
  AzureDevOpsAPIChangesPage
} from './types';
import { buildFilePatch, type FileChangeStatus } from './unified-diff';

export const MAX_DIFF_CHARS = 200000;
const MAX_CHANGE_PAGES = 20;
const CHANGES_PAGE_SIZE = 100;
const FETCH_BATCH_SIZE = 5;
const MAX_COMMITS = 100;

export interface AzureDevOpsPRContextResult {
  context: PRContext;
  headSha: string;
  sourceBranch: string;
  forkSource?: boolean;
}

interface AzureDevOpsAPICommit {
  commitId?: string;
  comment?: string;
  committer?: { date?: string };
}

interface ParsedChange {
  status: FileChangeStatus;
  oldPath: string;
  newPath: string;
}

export interface AzureDevOpsFilePatch extends ParsedChange {
  patch: string;
  additions: number;
  deletions: number;
}

function repoPath(config: AzureDevOpsConfig): string {
  return `/git/repositories/${encodeURIComponent(config.repository)}`;
}

function stripRefPrefix(ref: string | undefined): string {
  return (ref || '').replace(/^refs\/heads\//, '');
}

function stripLeadingSlash(p: string): string {
  return p.replace(/^\/+/, '');
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
    patches.set(match[2], chunk);
    if (!patches.has(match[1])) patches.set(match[1], chunk);
  }
  return patches;
}

function mapPrState(status: string | undefined): string {
  if (status === 'completed') return 'MERGED';
  if (status === 'abandoned') return 'DECLINED';
  return 'OPEN';
}

function mapFileStatus(status: FileChangeStatus): string {
  switch (status) {
    case 'add':
      return 'added';
    case 'delete':
      return 'removed';
    case 'rename':
      return 'renamed';
    default:
      return 'modified';
  }
}

function parseChange(change: AzureDevOpsAPIChange): ParsedChange | null {
  const itemPath = change.item?.path;
  if (!itemPath) return null;
  const types = (change.changeType ?? 'edit').toLowerCase().split(',').map((t) => t.trim());
  const newPath = stripLeadingSlash(itemPath);
  const oldPath = change.originalPath ? stripLeadingSlash(change.originalPath) : newPath;
  if (types.includes('delete')) return { status: 'delete', oldPath, newPath: oldPath };
  if (types.includes('add')) return { status: 'add', oldPath: newPath, newPath };
  if (types.includes('rename') && oldPath !== newPath) return { status: 'rename', oldPath, newPath };
  return { status: 'edit', oldPath: newPath, newPath };
}

async function fetchChanges(
  config: AzureDevOpsConfig,
  prBase: string,
  iterationId: number
): Promise<AzureDevOpsAPIChange[]> {
  const all: AzureDevOpsAPIChange[] = [];
  let skip = 0;
  for (let page = 0; page < MAX_CHANGE_PAGES; page += 1) {
    const data = (await azureDevOpsFetch(
      config,
      `${prBase}/iterations/${iterationId}/changes?$top=${CHANGES_PAGE_SIZE}&$skip=${skip}`
    )) as AzureDevOpsAPIChangesPage;
    if (Array.isArray(data.changeEntries)) all.push(...data.changeEntries);
    if (!data.nextSkip || data.nextSkip <= skip) break;
    skip = data.nextSkip;
  }
  return all;
}

/** Fetch file text at a commit; null when the file does not exist there (404). */
async function fetchFileText(
  config: AzureDevOpsConfig,
  filePath: string,
  sha: string
): Promise<string | null> {
  const endpoint =
    `${repoPath(config)}/items?path=${encodeURIComponent(`/${filePath}`)}` +
    `&versionDescriptor.versionType=commit&versionDescriptor.version=${encodeURIComponent(sha)}&$format=text`;
  try {
    return await azureDevOpsFetchText(config, endpoint);
  } catch (error) {
    if (error instanceof AzureDevOpsAPIError && error.statusCode === 404) return null;
    throw error;
  }
}

/**
 * Build per-file patches for the given parsed changes by fetching base/head content.
 */
async function buildPatches(
  config: AzureDevOpsConfig,
  changes: ParsedChange[],
  baseSha: string,
  headSha: string
): Promise<AzureDevOpsFilePatch[]> {
  const results: AzureDevOpsFilePatch[] = [];
  for (let i = 0; i < changes.length; i += FETCH_BATCH_SIZE) {
    const batch = changes.slice(i, i + FETCH_BATCH_SIZE);
    const built = await Promise.all(
      batch.map(async (change) => {
        const [oldText, newText] = await Promise.all([
          change.status === 'add' || !baseSha ? Promise.resolve(null) : fetchFileText(config, change.oldPath, baseSha),
          change.status === 'delete' ? Promise.resolve(null) : fetchFileText(config, change.newPath, headSha)
        ]);
        const file = buildFilePatch(change.oldPath, change.newPath, oldText, newText, change.status);
        return { ...change, ...file };
      })
    );
    results.push(...built);
  }
  return results;
}

async function fetchLatestIteration(
  config: AzureDevOpsConfig,
  prBase: string
): Promise<AzureDevOpsAPIIteration | null> {
  const page = (await azureDevOpsFetch(config, `${prBase}/iterations`)) as AzureDevOpsAPIPage<AzureDevOpsAPIIteration>;
  const iterations = Array.isArray(page.value) ? page.value : [];
  if (iterations.length === 0) return null;
  return iterations.reduce((a, b) => (b.id > a.id ? b : a));
}

/**
 * Fetch the file patches of a pull request's latest iteration.
 */
export async function fetchAzureDevOpsFilePatches(
  config: AzureDevOpsConfig,
  prId: number
): Promise<{ files: AzureDevOpsFilePatch[]; headSha: string; baseSha: string }> {
  const prBase = `${repoPath(config)}/pullrequests/${prId}`;
  const iteration = await fetchLatestIteration(config, prBase);
  const headSha = iteration?.sourceRefCommit?.commitId;
  if (!iteration || !headSha) {
    throw new Error(`Azure DevOps pull request #${prId} has no iterations`);
  }
  const baseSha = iteration.commonRefCommit?.commitId ?? '';
  const entries = await fetchChanges(config, prBase, iteration.id);
  const changes = entries
    .filter((e) => !(e.item as { isFolder?: boolean } | undefined)?.isFolder)
    .map(parseChange)
    .filter((c): c is ParsedChange => c !== null);
  const files = await buildPatches(config, changes, baseSha, headSha);
  return { files, headSha, baseSha };
}

export async function fetchAzureDevOpsPRContext(
  config: AzureDevOpsConfig,
  prId: number
): Promise<AzureDevOpsPRContextResult> {
  const prBase = `${repoPath(config)}/pullrequests/${prId}`;
  const pr = (await azureDevOpsFetch(config, prBase)) as AzureDevOpsAPIPullRequest;

  const { files, headSha } = await fetchAzureDevOpsFilePatches(config, prId);

  const commitPage = (await azureDevOpsFetch(
    config,
    `${prBase}/commits?$top=${MAX_COMMITS}`
  )) as AzureDevOpsAPIPage<AzureDevOpsAPICommit>;
  const apiCommits = Array.isArray(commitPage.value) ? commitPage.value : [];

  const rawDiff = files.map((f) => f.patch).join('');
  const diffTruncated = rawDiff.length > MAX_DIFF_CHARS;
  const diff = diffTruncated ? rawDiff.slice(0, MAX_DIFF_CHARS) : rawDiff;

  // Patches come from the full diff so truncation of `diff` does not lose them
  const patches = splitDiffByFile(rawDiff);

  let totalAdditions = 0;
  let totalDeletions = 0;
  const changedFiles: ChangedFile[] = files.map((f) => {
    totalAdditions += f.additions;
    totalDeletions += f.deletions;
    const patch = patches.get(f.newPath) ?? patches.get(f.oldPath);
    return {
      path: f.newPath,
      additions: f.additions,
      deletions: f.deletions,
      status: mapFileStatus(f.status),
      ...(patch ? { patch } : {})
    };
  });

  const sourceBranch = stripRefPrefix(pr.sourceRefName);

  const context: PRContext = {
    prNumber: prId,
    title: pr.title ?? '',
    description: pr.description ?? '',
    author: pr.createdBy?.displayName ?? pr.createdBy?.uniqueName ?? '',
    baseBranch: stripRefPrefix(pr.targetRefName),
    headBranch: sourceBranch,
    state: mapPrState(pr.status),
    changedFiles,
    diff,
    diffTruncated,
    repoStructure: '',
    relatedFiles: [],
    commits: apiCommits.map((c) => ({
      oid: c.commitId ?? '',
      messageHeadline: (c.comment ?? '').split('\n', 1)[0],
      committedDate: c.committer?.date ?? ''
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
    ...(pr.forkSource ? { forkSource: true } : {})
  };
}
