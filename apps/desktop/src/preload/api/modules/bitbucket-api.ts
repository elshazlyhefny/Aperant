import { IPC_CHANNELS } from '../../../shared/constants';
import type {
  BitbucketPullRequest,
  BitbucketSyncStatus,
  BitbucketDetectedRepository,
  BitbucketPRReviewProgress,
  BitbucketPostReviewOptions,
  BitbucketPostReviewResult,
  IPCResult
} from '../../../shared/types';
import type { PRReviewResult } from '../../../shared/types/pr-review';
import { createIpcListener, invokeIpc, sendIpc, IpcListenerCleanup } from './ipc-utils';
import type { PRLogs, PRLogsKnownVersion, PRLogsUpdatedPayload } from './github-api';

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

  // AI review
  runBitbucketPRReview: (projectId: string, prId: number) => void;
  cancelBitbucketPRReview: (projectId: string, prId: number) => Promise<boolean>;
  getBitbucketPRReview: (projectId: string, prId: number) => Promise<PRReviewResult | null>;
  getBitbucketPRLogs: (
    projectId: string,
    prId: number,
    known?: PRLogsKnownVersion
  ) => Promise<PRLogs | null | 'unchanged'>;
  postBitbucketPRReview: (
    projectId: string,
    prId: number,
    selectedFindingIds: string[],
    options: BitbucketPostReviewOptions
  ) => Promise<IPCResult<BitbucketPostReviewResult>>;

  // AI review event listeners
  onBitbucketPRReviewProgress: (
    callback: (projectId: string, progress: BitbucketPRReviewProgress) => void
  ) => IpcListenerCleanup;
  onBitbucketPRReviewComplete: (
    callback: (projectId: string, result: PRReviewResult) => void
  ) => IpcListenerCleanup;
  onBitbucketPRReviewError: (
    callback: (projectId: string, error: { prId: number; error: string }) => void
  ) => IpcListenerCleanup;
  onBitbucketPRLogsUpdated: (
    callback: (projectId: string, data: PRLogsUpdatedPayload) => void
  ) => IpcListenerCleanup;
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
    invokeIpc(IPC_CHANNELS.BITBUCKET_POST_PULL_REQUEST_COMMENT, projectId, prId, body),

  runBitbucketPRReview: (projectId: string, prId: number): void =>
    sendIpc(IPC_CHANNELS.BITBUCKET_PR_REVIEW, projectId, prId),

  cancelBitbucketPRReview: (projectId: string, prId: number): Promise<boolean> =>
    invokeIpc(IPC_CHANNELS.BITBUCKET_PR_REVIEW_CANCEL, projectId, prId),

  getBitbucketPRReview: (projectId: string, prId: number): Promise<PRReviewResult | null> =>
    invokeIpc(IPC_CHANNELS.BITBUCKET_PR_GET_REVIEW, projectId, prId),

  getBitbucketPRLogs: (
    projectId: string,
    prId: number,
    known?: PRLogsKnownVersion
  ): Promise<PRLogs | null | 'unchanged'> =>
    invokeIpc(IPC_CHANNELS.BITBUCKET_PR_GET_LOGS, projectId, prId, known),

  postBitbucketPRReview: (
    projectId: string,
    prId: number,
    selectedFindingIds: string[],
    options: BitbucketPostReviewOptions
  ): Promise<IPCResult<BitbucketPostReviewResult>> =>
    invokeIpc(IPC_CHANNELS.BITBUCKET_PR_POST_REVIEW, projectId, prId, selectedFindingIds, options),

  onBitbucketPRReviewProgress: (
    callback: (projectId: string, progress: BitbucketPRReviewProgress) => void
  ): IpcListenerCleanup =>
    createIpcListener(IPC_CHANNELS.BITBUCKET_PR_REVIEW_PROGRESS, callback),

  onBitbucketPRReviewComplete: (
    callback: (projectId: string, result: PRReviewResult) => void
  ): IpcListenerCleanup =>
    createIpcListener(IPC_CHANNELS.BITBUCKET_PR_REVIEW_COMPLETE, callback),

  onBitbucketPRReviewError: (
    callback: (projectId: string, error: { prId: number; error: string }) => void
  ): IpcListenerCleanup =>
    createIpcListener(IPC_CHANNELS.BITBUCKET_PR_REVIEW_ERROR, callback),

  onBitbucketPRLogsUpdated: (
    callback: (projectId: string, data: PRLogsUpdatedPayload) => void
  ): IpcListenerCleanup =>
    createIpcListener(IPC_CHANNELS.BITBUCKET_PR_LOGS_UPDATED, callback)
});
