// zeenha fork: Azure DevOps preload bridge, not present upstream.
import { IPC_CHANNELS } from '../../../shared/constants';
import type {
  AzureDevOpsSyncStatus,
  AzureDevOpsDetectedRepository,
  AzureDevOpsPullRequest,
  AzureDevOpsPRReviewProgress,
  AzureDevOpsPostReviewOptions,
  AzureDevOpsPostReviewResult,
  IPCResult
} from '../../../shared/types';
import type { PRReviewResult } from '../../../shared/types/pr-review';
import { createIpcListener, invokeIpc, sendIpc, IpcListenerCleanup } from './ipc-utils';
import type { PRLogs, PRLogsKnownVersion, PRLogsUpdatedPayload } from './github-api';

/**
 * Azure DevOps Integration API operations
 */
export interface AzureDevOpsAPI {
  checkAzureDevOpsConnection: (projectId: string) => Promise<IPCResult<AzureDevOpsSyncStatus>>;
  detectAzureDevOpsRepository: (projectId: string) => Promise<IPCResult<AzureDevOpsDetectedRepository | null>>;
  getAzureDevOpsPullRequests: (projectId: string, state?: string) => Promise<IPCResult<AzureDevOpsPullRequest[]>>;
  getAzureDevOpsPullRequest: (projectId: string, prId: number) => Promise<IPCResult<AzureDevOpsPullRequest>>;
  getAzureDevOpsPullRequestDiff: (projectId: string, prId: number) => Promise<IPCResult<string>>;
  postAzureDevOpsPullRequestComment: (projectId: string, prId: number, body: string) => Promise<IPCResult<{ id: number }>>;

  // AI review
  runAzureDevOpsPRReview: (projectId: string, prId: number) => void;
  cancelAzureDevOpsPRReview: (projectId: string, prId: number) => Promise<boolean>;
  getAzureDevOpsPRReview: (projectId: string, prId: number) => Promise<PRReviewResult | null>;
  getAzureDevOpsPRLogs: (
    projectId: string,
    prId: number,
    known?: PRLogsKnownVersion
  ) => Promise<PRLogs | null | 'unchanged'>;
  postAzureDevOpsPRReview: (
    projectId: string,
    prId: number,
    selectedFindingIds: string[],
    options: AzureDevOpsPostReviewOptions
  ) => Promise<IPCResult<AzureDevOpsPostReviewResult>>;

  // AI review event listeners
  onAzureDevOpsPRReviewProgress: (
    callback: (projectId: string, progress: AzureDevOpsPRReviewProgress) => void
  ) => IpcListenerCleanup;
  onAzureDevOpsPRReviewComplete: (
    callback: (projectId: string, result: PRReviewResult) => void
  ) => IpcListenerCleanup;
  onAzureDevOpsPRReviewError: (
    callback: (projectId: string, error: { prId: number; error: string }) => void
  ) => IpcListenerCleanup;
  onAzureDevOpsPRLogsUpdated: (
    callback: (projectId: string, data: PRLogsUpdatedPayload) => void
  ) => IpcListenerCleanup;
}

/**
 * Creates the Azure DevOps Integration API implementation
 */
export const createAzureDevOpsAPI = (): AzureDevOpsAPI => ({
  checkAzureDevOpsConnection: (projectId: string): Promise<IPCResult<AzureDevOpsSyncStatus>> =>
    invokeIpc(IPC_CHANNELS.AZUREDEVOPS_CHECK_CONNECTION, projectId),

  detectAzureDevOpsRepository: (projectId: string): Promise<IPCResult<AzureDevOpsDetectedRepository | null>> =>
    invokeIpc(IPC_CHANNELS.AZUREDEVOPS_DETECT_REPOSITORY, projectId),

  getAzureDevOpsPullRequests: (projectId: string, state?: string): Promise<IPCResult<AzureDevOpsPullRequest[]>> =>
    invokeIpc(IPC_CHANNELS.AZUREDEVOPS_GET_PULL_REQUESTS, projectId, state),

  getAzureDevOpsPullRequest: (projectId: string, prId: number): Promise<IPCResult<AzureDevOpsPullRequest>> =>
    invokeIpc(IPC_CHANNELS.AZUREDEVOPS_GET_PULL_REQUEST, projectId, prId),

  getAzureDevOpsPullRequestDiff: (projectId: string, prId: number): Promise<IPCResult<string>> =>
    invokeIpc(IPC_CHANNELS.AZUREDEVOPS_GET_PULL_REQUEST_DIFF, projectId, prId),

  postAzureDevOpsPullRequestComment: (projectId: string, prId: number, body: string): Promise<IPCResult<{ id: number }>> =>
    invokeIpc(IPC_CHANNELS.AZUREDEVOPS_POST_PULL_REQUEST_COMMENT, projectId, prId, body),

  runAzureDevOpsPRReview: (projectId: string, prId: number): void =>
    sendIpc(IPC_CHANNELS.AZUREDEVOPS_PR_REVIEW, projectId, prId),

  cancelAzureDevOpsPRReview: (projectId: string, prId: number): Promise<boolean> =>
    invokeIpc(IPC_CHANNELS.AZUREDEVOPS_PR_REVIEW_CANCEL, projectId, prId),

  getAzureDevOpsPRReview: (projectId: string, prId: number): Promise<PRReviewResult | null> =>
    invokeIpc(IPC_CHANNELS.AZUREDEVOPS_PR_GET_REVIEW, projectId, prId),

  getAzureDevOpsPRLogs: (
    projectId: string,
    prId: number,
    known?: PRLogsKnownVersion
  ): Promise<PRLogs | null | 'unchanged'> =>
    invokeIpc(IPC_CHANNELS.AZUREDEVOPS_PR_GET_LOGS, projectId, prId, known),

  postAzureDevOpsPRReview: (
    projectId: string,
    prId: number,
    selectedFindingIds: string[],
    options: AzureDevOpsPostReviewOptions
  ): Promise<IPCResult<AzureDevOpsPostReviewResult>> =>
    invokeIpc(IPC_CHANNELS.AZUREDEVOPS_PR_POST_REVIEW, projectId, prId, selectedFindingIds, options),

  onAzureDevOpsPRReviewProgress: (
    callback: (projectId: string, progress: AzureDevOpsPRReviewProgress) => void
  ): IpcListenerCleanup =>
    createIpcListener(IPC_CHANNELS.AZUREDEVOPS_PR_REVIEW_PROGRESS, callback),

  onAzureDevOpsPRReviewComplete: (
    callback: (projectId: string, result: PRReviewResult) => void
  ): IpcListenerCleanup =>
    createIpcListener(IPC_CHANNELS.AZUREDEVOPS_PR_REVIEW_COMPLETE, callback),

  onAzureDevOpsPRReviewError: (
    callback: (projectId: string, error: { prId: number; error: string }) => void
  ): IpcListenerCleanup =>
    createIpcListener(IPC_CHANNELS.AZUREDEVOPS_PR_REVIEW_ERROR, callback),

  onAzureDevOpsPRLogsUpdated: (
    callback: (projectId: string, data: PRLogsUpdatedPayload) => void
  ): IpcListenerCleanup =>
    createIpcListener(IPC_CHANNELS.AZUREDEVOPS_PR_LOGS_UPDATED, callback)
});
