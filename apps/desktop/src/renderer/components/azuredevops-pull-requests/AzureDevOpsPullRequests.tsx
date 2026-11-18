import { BitbucketPullRequests } from '../bitbucket-pull-requests';
import type { PullRequestListApi, PullRequestReviewApi } from '../bitbucket-pull-requests';

/** Must match NOT_CONFIGURED in main/ipc-handlers/azuredevops/pull-request-handlers.ts. */
export const AZURE_DEVOPS_NOT_CONFIGURED_ERROR = 'Azure DevOps not configured';

/** zeenha fork: adapter over the Azure DevOps IPC calls (resolved at call time). */
export const azureDevOpsPRApi: PullRequestListApi = {
  listPullRequests: (projectId, state) => window.electronAPI.getAzureDevOpsPullRequests(projectId, state),
  getPullRequest: (projectId, prId) => window.electronAPI.getAzureDevOpsPullRequest(projectId, prId),
  getDiff: (projectId, prId) => window.electronAPI.getAzureDevOpsPullRequestDiff(projectId, prId),
  postComment: (projectId, prId, body) =>
    window.electronAPI.postAzureDevOpsPullRequestComment(projectId, prId, body),
  notConfiguredError: AZURE_DEVOPS_NOT_CONFIGURED_ERROR
};

export const azureDevOpsPRReviewApi: PullRequestReviewApi = {
  run: (projectId, prId) => window.electronAPI.runAzureDevOpsPRReview(projectId, prId),
  cancel: (projectId, prId) => window.electronAPI.cancelAzureDevOpsPRReview(projectId, prId),
  getReview: (projectId, prId) => window.electronAPI.getAzureDevOpsPRReview(projectId, prId),
  getLogs: (projectId, prId, known) => window.electronAPI.getAzureDevOpsPRLogs(projectId, prId, known),
  postReview: (projectId, prId, ids, options) =>
    window.electronAPI.postAzureDevOpsPRReview(projectId, prId, ids, options),
  onProgress: (cb) => window.electronAPI.onAzureDevOpsPRReviewProgress?.(cb),
  onComplete: (cb) => window.electronAPI.onAzureDevOpsPRReviewComplete?.(cb),
  onError: (cb) => window.electronAPI.onAzureDevOpsPRReviewError?.(cb),
  onLogsUpdated: (cb) => window.electronAPI.onAzureDevOpsPRLogsUpdated?.(cb)
};

interface AzureDevOpsPullRequestsProps {
  projectId: string;
  onOpenSettings?: () => void;
}

export function AzureDevOpsPullRequests({ projectId, onOpenSettings }: AzureDevOpsPullRequestsProps) {
  return (
    <BitbucketPullRequests
      projectId={projectId}
      onOpenSettings={onOpenSettings}
      listApi={azureDevOpsPRApi}
      reviewApi={azureDevOpsPRReviewApi}
      i18nNamespace="azuredevops"
      testId="azuredevops"
    />
  );
}
