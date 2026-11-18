/**
 * Azure DevOps pull request list, detail and comment handlers
 *
 * zeenha fork: Azure DevOps support does not exist upstream.
 * Connection/detection handlers live in connection-handlers.ts.
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult, AzureDevOpsPullRequest } from '../../../shared/types';
import { projectStore } from '../../project-store';
import {
  getAzureDevOpsConfig,
  azureDevOpsFetch,
  postAzureDevOpsThread,
  buildPullRequestWebUrl,
  MAX_COMMENT_LENGTH
} from './utils';
import type {
  AzureDevOpsConfig,
  AzureDevOpsAPIPullRequest,
  AzureDevOpsAPIPage,
  AzureDevOpsAPIIdentity
} from './types';
import { fetchAzureDevOpsFilePatches } from './review-context';
import { createDebugLog } from '../../../shared/utils/debug-logger';

const debugLog = createDebugLog('AzureDevOps PR');

export const VALID_PR_STATES = ['OPEN', 'MERGED', 'DECLINED', 'ALL'] as const;
type PullRequestStateFilter = typeof VALID_PR_STATES[number];

const STATE_TO_STATUS: Record<PullRequestStateFilter, string> = {
  OPEN: 'active',
  MERGED: 'completed',
  DECLINED: 'abandoned',
  ALL: 'all'
};

const NOT_CONFIGURED = 'Azure DevOps not configured';

export function isValidPullRequestState(state: string): state is PullRequestStateFilter {
  return VALID_PR_STATES.includes(state as PullRequestStateFilter);
}

export function isValidPrId(id: unknown): id is number {
  return typeof id === 'number' && Number.isInteger(id) && id > 0;
}

function transformIdentity(user: AzureDevOpsAPIIdentity | null | undefined): { displayName: string; avatarUrl?: string } {
  return {
    displayName: user?.displayName || user?.uniqueName || '',
    avatarUrl: user?.imageUrl || undefined
  };
}

function mapStatus(status: string | undefined): AzureDevOpsPullRequest['state'] {
  if (status === 'completed') return 'MERGED';
  if (status === 'abandoned') return 'DECLINED';
  return 'OPEN';
}

function stripRefPrefix(ref: string | undefined): string {
  return (ref || '').replace(/^refs\/heads\//, '');
}

/**
 * Transform an Azure DevOps API pull request to our format.
 * commentCount is 0 because the PR payload does not carry it.
 */
export function transformPullRequest(apiPr: AzureDevOpsAPIPullRequest, config: AzureDevOpsConfig): AzureDevOpsPullRequest {
  const createdAt = apiPr.creationDate || new Date().toISOString();
  return {
    id: apiPr.pullRequestId,
    title: apiPr.title || '',
    description: apiPr.description || undefined,
    state: mapStatus(apiPr.status),
    sourceBranch: stripRefPrefix(apiPr.sourceRefName),
    targetBranch: stripRefPrefix(apiPr.targetRefName),
    author: transformIdentity(apiPr.createdBy),
    reviewers: Array.isArray(apiPr.reviewers) ? apiPr.reviewers.map(transformIdentity) : [],
    commentCount: 0,
    webUrl: buildPullRequestWebUrl(config, apiPr.pullRequestId),
    createdAt,
    updatedAt: apiPr.closedDate || createdAt
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function repoPath(config: AzureDevOpsConfig): string {
  return `/git/repositories/${encodeURIComponent(config.repository)}`;
}

export function registerGetPullRequests(): void {
  ipcMain.handle(
    IPC_CHANNELS.AZUREDEVOPS_GET_PULL_REQUESTS,
    async (_event, projectId: string, state?: string): Promise<IPCResult<AzureDevOpsPullRequest[]>> => {
      debugLog('getAzureDevOpsPullRequests handler called', { state });
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };

      const config = await getAzureDevOpsConfig(project);
      if (!config) return { success: false, error: NOT_CONFIGURED };

      const stateParam = state ?? 'OPEN';
      if (!isValidPullRequestState(stateParam)) {
        return {
          success: false,
          error: `Invalid pull request state: '${stateParam}'. Must be one of: ${VALID_PR_STATES.join(', ')}`
        };
      }

      try {
        const page = (await azureDevOpsFetch(
          config,
          `${repoPath(config)}/pullrequests?searchCriteria.status=${STATE_TO_STATUS[stateParam]}&$top=50`
        )) as AzureDevOpsAPIPage<AzureDevOpsAPIPullRequest>;
        const values = Array.isArray(page.value) ? page.value : [];
        debugLog('Fetched pull requests:', values.length);
        return { success: true, data: values.map(pr => transformPullRequest(pr, config)) };
      } catch (error) {
        debugLog('Failed to get pull requests:', errorMessage(error, 'unknown'));
        return { success: false, error: errorMessage(error, 'Failed to get pull requests') };
      }
    }
  );
}

export function registerGetPullRequest(): void {
  ipcMain.handle(
    IPC_CHANNELS.AZUREDEVOPS_GET_PULL_REQUEST,
    async (_event, projectId: string, prId: number): Promise<IPCResult<AzureDevOpsPullRequest>> => {
      debugLog('getAzureDevOpsPullRequest handler called', { prId });
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };

      const config = await getAzureDevOpsConfig(project);
      if (!config) return { success: false, error: NOT_CONFIGURED };
      if (!isValidPrId(prId)) return { success: false, error: 'Invalid pull request id' };

      try {
        const apiPr = (await azureDevOpsFetch(
          config,
          `${repoPath(config)}/pullrequests/${prId}`
        )) as AzureDevOpsAPIPullRequest;
        return { success: true, data: transformPullRequest(apiPr, config) };
      } catch (error) {
        debugLog('Failed to get pull request:', errorMessage(error, 'unknown'));
        return { success: false, error: errorMessage(error, 'Failed to get pull request') };
      }
    }
  );
}

export function registerPostPullRequestComment(): void {
  ipcMain.handle(
    IPC_CHANNELS.AZUREDEVOPS_POST_PULL_REQUEST_COMMENT,
    async (_event, projectId: string, prId: number, body: string): Promise<IPCResult<{ id: number }>> => {
      debugLog('postAzureDevOpsPullRequestComment handler called', { prId });
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };

      const config = await getAzureDevOpsConfig(project);
      if (!config) return { success: false, error: NOT_CONFIGURED };
      if (!isValidPrId(prId)) return { success: false, error: 'Invalid pull request id' };

      if (typeof body !== 'string' || !body.trim()) {
        return { success: false, error: 'Comment body cannot be empty' };
      }
      if (body.length > MAX_COMMENT_LENGTH) {
        return { success: false, error: `Comment body exceeds ${MAX_COMMENT_LENGTH} characters` };
      }

      try {
        const thread = await postAzureDevOpsThread(config, prId, body);
        return { success: true, data: { id: thread.id } };
      } catch (error) {
        debugLog('Failed to post comment:', errorMessage(error, 'unknown'));
        return { success: false, error: errorMessage(error, 'Failed to post comment') };
      }
    }
  );
}

/**
 * Build the full unified diff text of a pull request (latest iteration).
 */
export async function buildAzureDevOpsPullRequestDiff(config: AzureDevOpsConfig, prId: number): Promise<string> {
  const { files } = await fetchAzureDevOpsFilePatches(config, prId);
  return files.map(f => f.patch).join('');
}

export function registerGetPullRequestDiff(): void {
  ipcMain.handle(
    IPC_CHANNELS.AZUREDEVOPS_GET_PULL_REQUEST_DIFF,
    async (_event, projectId: string, prId: number): Promise<IPCResult<string>> => {
      debugLog('getAzureDevOpsPullRequestDiff handler called', { prId });
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };

      const config = await getAzureDevOpsConfig(project);
      if (!config) return { success: false, error: NOT_CONFIGURED };
      if (!isValidPrId(prId)) return { success: false, error: 'Invalid pull request id' };

      try {
        return { success: true, data: await buildAzureDevOpsPullRequestDiff(config, prId) };
      } catch (error) {
        debugLog('Failed to get pull request diff:', errorMessage(error, 'unknown'));
        return { success: false, error: errorMessage(error, 'Failed to get pull request diff') };
      }
    }
  );
}
