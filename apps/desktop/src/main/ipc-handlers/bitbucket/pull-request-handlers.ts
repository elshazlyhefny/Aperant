/**
 * Bitbucket Pull Request handlers
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../../shared/constants';
import type {
  IPCResult,
  BitbucketPullRequest,
  BitbucketSyncStatus,
  BitbucketDetectedRepository
} from '../../../shared/types';
import { projectStore } from '../../project-store';
import {
  getBitbucketConfig,
  bitbucketFetch,
  bitbucketFetchText,
  detectBitbucketRepositoryFromRemote,
  postBitbucketComment,
  MAX_COMMENT_LENGTH
} from './utils';
import type {
  BitbucketAPIPullRequest,
  BitbucketAPIPage,
  BitbucketAPIRepository,
  BitbucketAPIUser
} from './types';
import { createDebugLog } from '../../../shared/utils/debug-logger';

const debugLog = createDebugLog('Bitbucket PR');

export const VALID_PR_STATES = ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED', 'ALL'] as const;
type PullRequestStateFilter = typeof VALID_PR_STATES[number];

const CONCRETE_STATES = ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'] as const;
type PullRequestState = BitbucketPullRequest['state'];

const NOT_CONFIGURED = 'Bitbucket not configured';

export function isValidPullRequestState(state: string): state is PullRequestStateFilter {
  return VALID_PR_STATES.includes(state as PullRequestStateFilter);
}

function transformUser(user: BitbucketAPIUser | null | undefined): { displayName: string; avatarUrl?: string } {
  return {
    displayName: user?.display_name || user?.nickname || '',
    avatarUrl: user?.links?.avatar?.href || undefined
  };
}

/**
 * Transform Bitbucket API pull request to our format.
 * Defensively handles missing/null properties.
 */
export function transformPullRequest(apiPr: BitbucketAPIPullRequest): BitbucketPullRequest {
  const state = (CONCRETE_STATES as readonly string[]).includes(apiPr.state ?? '')
    ? (apiPr.state as PullRequestState)
    : 'OPEN';
  const now = new Date().toISOString();
  return {
    id: apiPr.id,
    title: apiPr.title || '',
    description: apiPr.description || undefined,
    state,
    sourceBranch: apiPr.source?.branch?.name || '',
    targetBranch: apiPr.destination?.branch?.name || '',
    author: transformUser(apiPr.author),
    reviewers: Array.isArray(apiPr.reviewers) ? apiPr.reviewers.map(transformUser) : [],
    commentCount: typeof apiPr.comment_count === 'number' ? apiPr.comment_count : 0,
    webUrl: apiPr.links?.html?.href || '',
    createdAt: apiPr.created_on || now,
    updatedAt: apiPr.updated_on || apiPr.created_on || now
  };
}

export function isValidPrId(id: unknown): id is number {
  return typeof id === 'number' && Number.isInteger(id) && id > 0;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function registerCheckConnection(): void {
  ipcMain.handle(
    IPC_CHANNELS.BITBUCKET_CHECK_CONNECTION,
    async (_event, projectId: string): Promise<IPCResult<BitbucketSyncStatus>> => {
      debugLog('checkBitbucketConnection handler called');
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };

      const config = await getBitbucketConfig(project);
      if (!config) return { success: false, error: NOT_CONFIGURED };

      try {
        const repo = await bitbucketFetch(
          config,
          `/repositories/${encodeURIComponent(config.repository.split('/')[0])}/${encodeURIComponent(config.repository.split('/')[1])}`
        ) as BitbucketAPIRepository;
        return {
          success: true,
          data: { connected: true, repoFullName: repo.full_name || config.repository }
        };
      } catch (error) {
        debugLog('Connection check failed:', errorMessage(error, 'unknown'));
        return {
          success: true,
          data: {
            connected: false,
            repoFullName: config.repository,
            error: errorMessage(error, 'Failed to connect to Bitbucket')
          }
        };
      }
    }
  );
}

export function registerDetectRepository(): void {
  ipcMain.handle(
    IPC_CHANNELS.BITBUCKET_DETECT_REPOSITORY,
    async (_event, projectId: string): Promise<IPCResult<BitbucketDetectedRepository | null>> => {
      debugLog('detectBitbucketRepository handler called');
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };

      return { success: true, data: detectBitbucketRepositoryFromRemote(project.path) };
    }
  );
}

function repoPath(repository: string): string {
  const [workspace, slug] = repository.split('/');
  return `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}`;
}

export function registerGetPullRequests(): void {
  ipcMain.handle(
    IPC_CHANNELS.BITBUCKET_GET_PULL_REQUESTS,
    async (_event, projectId: string, state?: string): Promise<IPCResult<BitbucketPullRequest[]>> => {
      debugLog('getBitbucketPullRequests handler called', { state });
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };

      const config = await getBitbucketConfig(project);
      if (!config) return { success: false, error: NOT_CONFIGURED };

      const stateParam = state ?? 'OPEN';
      if (!isValidPullRequestState(stateParam)) {
        return {
          success: false,
          error: `Invalid pull request state: '${stateParam}'. Must be one of: ${VALID_PR_STATES.join(', ')}`
        };
      }

      try {
        const states = stateParam === 'ALL' ? CONCRETE_STATES : [stateParam];
        const query = [
          ...states.map(s => `state=${s}`),
          'pagelen=50',
          `sort=${encodeURIComponent('-updated_on')}`
        ].join('&');
        const page = await bitbucketFetch(
          config,
          `${repoPath(config.repository)}/pullrequests?${query}`
        ) as BitbucketAPIPage<BitbucketAPIPullRequest>;

        const values = Array.isArray(page.values) ? page.values : [];
        debugLog('Fetched pull requests:', values.length);
        return { success: true, data: values.map(transformPullRequest) };
      } catch (error) {
        debugLog('Failed to get pull requests:', errorMessage(error, 'unknown'));
        return { success: false, error: errorMessage(error, 'Failed to get pull requests') };
      }
    }
  );
}

export function registerGetPullRequest(): void {
  ipcMain.handle(
    IPC_CHANNELS.BITBUCKET_GET_PULL_REQUEST,
    async (_event, projectId: string, prId: number): Promise<IPCResult<BitbucketPullRequest>> => {
      debugLog('getBitbucketPullRequest handler called', { prId });
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };

      const config = await getBitbucketConfig(project);
      if (!config) return { success: false, error: NOT_CONFIGURED };
      if (!isValidPrId(prId)) return { success: false, error: 'Invalid pull request id' };

      try {
        const apiPr = await bitbucketFetch(
          config,
          `${repoPath(config.repository)}/pullrequests/${prId}`
        ) as BitbucketAPIPullRequest;
        return { success: true, data: transformPullRequest(apiPr) };
      } catch (error) {
        debugLog('Failed to get pull request:', errorMessage(error, 'unknown'));
        return { success: false, error: errorMessage(error, 'Failed to get pull request') };
      }
    }
  );
}

export function registerGetPullRequestDiff(): void {
  ipcMain.handle(
    IPC_CHANNELS.BITBUCKET_GET_PULL_REQUEST_DIFF,
    async (_event, projectId: string, prId: number): Promise<IPCResult<string>> => {
      debugLog('getBitbucketPullRequestDiff handler called', { prId });
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };

      const config = await getBitbucketConfig(project);
      if (!config) return { success: false, error: NOT_CONFIGURED };
      if (!isValidPrId(prId)) return { success: false, error: 'Invalid pull request id' };

      try {
        const diff = await bitbucketFetchText(
          config,
          `${repoPath(config.repository)}/pullrequests/${prId}/diff`
        );
        return { success: true, data: diff };
      } catch (error) {
        debugLog('Failed to get pull request diff:', errorMessage(error, 'unknown'));
        return { success: false, error: errorMessage(error, 'Failed to get pull request diff') };
      }
    }
  );
}

export function registerPostPullRequestComment(): void {
  ipcMain.handle(
    IPC_CHANNELS.BITBUCKET_POST_PULL_REQUEST_COMMENT,
    async (_event, projectId: string, prId: number, body: string): Promise<IPCResult<{ id: number }>> => {
      debugLog('postBitbucketPullRequestComment handler called', { prId });
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };

      const config = await getBitbucketConfig(project);
      if (!config) return { success: false, error: NOT_CONFIGURED };
      if (!isValidPrId(prId)) return { success: false, error: 'Invalid pull request id' };

      if (typeof body !== 'string' || !body.trim()) {
        return { success: false, error: 'Comment body cannot be empty' };
      }
      if (body.length > MAX_COMMENT_LENGTH) {
        return { success: false, error: `Comment body exceeds ${MAX_COMMENT_LENGTH} characters` };
      }

      try {
        const comment = await postBitbucketComment(config, prId, body);
        return { success: true, data: { id: comment.id } };
      } catch (error) {
        debugLog('Failed to post comment:', errorMessage(error, 'unknown'));
        return { success: false, error: errorMessage(error, 'Failed to post comment') };
      }
    }
  );
}
