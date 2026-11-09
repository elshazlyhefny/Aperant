import { IPC_CHANNELS } from '../../../shared/constants';
import type {
  BitbucketPullRequest,
  BitbucketSyncStatus,
  BitbucketDetectedRepository,
  IPCResult
} from '../../../shared/types';
import { invokeIpc } from './ipc-utils';

/**
 * Bitbucket Integration API operations
 */
export interface BitbucketAPI {
  checkBitbucketConnection: (projectId: string) => Promise<IPCResult<BitbucketSyncStatus>>;
  detectBitbucketRepository: (projectId: string) => Promise<IPCResult<BitbucketDetectedRepository | null>>;
  getBitbucketPullRequests: (projectId: string, state?: string) => Promise<IPCResult<BitbucketPullRequest[]>>;
  getBitbucketPullRequest: (projectId: string, prId: number) => Promise<IPCResult<BitbucketPullRequest>>;
  getBitbucketPullRequestDiff: (projectId: string, prId: number) => Promise<IPCResult<string>>;
  postBitbucketPullRequestComment: (projectId: string, prId: number, body: string) => Promise<IPCResult<{ id: number }>>;
}

/**
 * Creates the Bitbucket Integration API implementation
 */
export const createBitbucketAPI = (): BitbucketAPI => ({
  checkBitbucketConnection: (projectId: string): Promise<IPCResult<BitbucketSyncStatus>> =>
    invokeIpc(IPC_CHANNELS.BITBUCKET_CHECK_CONNECTION, projectId),

  detectBitbucketRepository: (projectId: string): Promise<IPCResult<BitbucketDetectedRepository | null>> =>
    invokeIpc(IPC_CHANNELS.BITBUCKET_DETECT_REPOSITORY, projectId),

  getBitbucketPullRequests: (projectId: string, state?: string): Promise<IPCResult<BitbucketPullRequest[]>> =>
    invokeIpc(IPC_CHANNELS.BITBUCKET_GET_PULL_REQUESTS, projectId, state),

  getBitbucketPullRequest: (projectId: string, prId: number): Promise<IPCResult<BitbucketPullRequest>> =>
    invokeIpc(IPC_CHANNELS.BITBUCKET_GET_PULL_REQUEST, projectId, prId),

  getBitbucketPullRequestDiff: (projectId: string, prId: number): Promise<IPCResult<string>> =>
    invokeIpc(IPC_CHANNELS.BITBUCKET_GET_PULL_REQUEST_DIFF, projectId, prId),

  postBitbucketPullRequestComment: (projectId: string, prId: number, body: string): Promise<IPCResult<{ id: number }>> =>
    invokeIpc(IPC_CHANNELS.BITBUCKET_POST_PULL_REQUEST_COMMENT, projectId, prId, body)
});
