/**
 * zeenha fork: Azure DevOps PR review IPC handlers (run, cancel, read result, read logs).
 * The post-review handler is registered separately from index.ts.
 */

import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../../shared/constants';
import type { PRReviewResult } from '../../../shared/types/pr-review';
import { withProjectOrNull } from '../github/utils/project-middleware';
import { createIPCCommunicators } from '../shared/ipc-communicator';
import { loadPRLogsIfChanged, type PRLogs, type PRLogsKnownVersion } from '../github/pr/review-logs';
import { isValidPrId } from './pull-request-handlers';
import { getAzureDevOpsReviewResult } from './review-results';
import { runAzureDevOpsPRReview, type AzureDevOpsReviewProgress, runningAzureDevOpsReviews, getAzureDevOpsReviewKey } from './review-runner';
import { createDebugLog } from '../../../shared/utils/debug-logger';

const debugLog = createDebugLog('Azure DevOps PR Review');

const CHANNELS = {
  progress: IPC_CHANNELS.AZUREDEVOPS_PR_REVIEW_PROGRESS,
  error: IPC_CHANNELS.AZUREDEVOPS_PR_REVIEW_ERROR,
  complete: IPC_CHANNELS.AZUREDEVOPS_PR_REVIEW_COMPLETE
};

export function registerAzureDevOpsReviewHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.on(IPC_CHANNELS.AZUREDEVOPS_PR_REVIEW, async (_event, projectId: string, prId: number) => {
    const mainWindow = getMainWindow();
    if (!mainWindow) {
      debugLog('No main window available');
      return;
    }

    const { sendProgress, sendComplete, sendError } = createIPCCommunicators<AzureDevOpsReviewProgress, PRReviewResult>(
      mainWindow,
      CHANNELS,
      projectId
    );

    if (!isValidPrId(prId)) {
      sendError({ prNumber: prId, prId, error: 'Invalid pull request id' });
      return;
    }

    try {
      await withProjectOrNull(projectId, async (project) => {
        if (runningAzureDevOpsReviews.has(getAzureDevOpsReviewKey(projectId, prId))) {
          sendProgress({
            phase: 'analyzing',
            prNumber: prId,
            prId,
            progress: 50,
            message: 'Review is already in progress. Reconnecting to ongoing review...'
          });
          return;
        }

        sendProgress({ phase: 'fetching', prNumber: prId, prId, progress: 10, message: 'Fetching PR data...' });
        const result = await runAzureDevOpsPRReview(project, prId, mainWindow);
        sendProgress({ phase: 'complete', prNumber: prId, prId, progress: 100, message: 'Review complete!' });
        sendComplete(result);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to run PR review';
      debugLog('PR review failed', { prId, error: message });
      sendError({ prNumber: prId, prId, error: message });
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.AZUREDEVOPS_PR_REVIEW_CANCEL,
    async (_event, projectId: string, prId: number): Promise<boolean> => {
      const reviewKey = getAzureDevOpsReviewKey(projectId, prId);
      const controller = runningAzureDevOpsReviews.get(reviewKey);
      if (!controller) return false;
      controller.abort();
      runningAzureDevOpsReviews.delete(reviewKey);
      return true;
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AZUREDEVOPS_PR_GET_REVIEW,
    async (_event, projectId: string, prId: number): Promise<PRReviewResult | null> => {
      if (!isValidPrId(prId)) return null;
      return withProjectOrNull(projectId, async (project) => getAzureDevOpsReviewResult(project, prId));
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AZUREDEVOPS_PR_GET_LOGS,
    async (
      _event,
      projectId: string,
      prId: number,
      known?: PRLogsKnownVersion
    ): Promise<PRLogs | null | 'unchanged'> => {
      if (!isValidPrId(prId)) return null;
      return withProjectOrNull(projectId, async (project) =>
        loadPRLogsIfChanged(project, prId, known, 'azuredevops')
      );
    }
  );
}
