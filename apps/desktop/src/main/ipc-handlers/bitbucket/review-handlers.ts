/**
 * zeenha fork: Bitbucket PR review IPC handlers (run, cancel, read result, read logs).
 */

import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../../shared/constants';
import type { PRReviewResult, PRReviewProgress } from '../../../shared/types/pr-review';
import { withProjectOrNull } from '../github/utils/project-middleware';
import { createIPCCommunicators } from '../shared/ipc-communicator';
import { loadPRLogsIfChanged, type PRLogs, type PRLogsKnownVersion } from '../github/pr/review-logs';
import { isValidPrId } from './pull-request-handlers';
import { getBitbucketReviewResult } from './review-results';
import { runBitbucketPRReview, runningBitbucketReviews, getBitbucketReviewKey } from './review-runner';
import { createDebugLog } from '../../../shared/utils/debug-logger';

const debugLog = createDebugLog('Bitbucket PR Review');

const CHANNELS = {
  progress: IPC_CHANNELS.BITBUCKET_PR_REVIEW_PROGRESS,
  error: IPC_CHANNELS.BITBUCKET_PR_REVIEW_ERROR,
  complete: IPC_CHANNELS.BITBUCKET_PR_REVIEW_COMPLETE
};

export function registerBitbucketReviewHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.on(IPC_CHANNELS.BITBUCKET_PR_REVIEW, async (_event, projectId: string, prId: number) => {
    const mainWindow = getMainWindow();
    if (!mainWindow) {
      debugLog('No main window available');
      return;
    }

    const { sendProgress, sendComplete, sendError } = createIPCCommunicators<PRReviewProgress, PRReviewResult>(
      mainWindow,
      CHANNELS,
      projectId
    );

    if (!isValidPrId(prId)) {
      sendError({ prNumber: prId, error: 'Invalid pull request id' });
      return;
    }

    try {
      await withProjectOrNull(projectId, async (project) => {
        if (runningBitbucketReviews.has(getBitbucketReviewKey(projectId, prId))) {
          sendProgress({
            phase: 'analyzing',
            prNumber: prId,
            progress: 50,
            message: 'Review is already in progress. Reconnecting to ongoing review...'
          });
          return;
        }

        sendProgress({ phase: 'fetching', prNumber: prId, progress: 10, message: 'Fetching PR data...' });
        const result = await runBitbucketPRReview(project, prId, mainWindow);
        sendProgress({ phase: 'complete', prNumber: prId, progress: 100, message: 'Review complete!' });
        sendComplete(result);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to run PR review';
      debugLog('PR review failed', { prId, error: message });
      sendError({ prNumber: prId, error: message });
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.BITBUCKET_PR_REVIEW_CANCEL,
    async (_event, projectId: string, prId: number): Promise<boolean> => {
      const reviewKey = getBitbucketReviewKey(projectId, prId);
      const controller = runningBitbucketReviews.get(reviewKey);
      if (!controller) return false;
      controller.abort();
      runningBitbucketReviews.delete(reviewKey);
      return true;
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.BITBUCKET_PR_GET_REVIEW,
    async (_event, projectId: string, prId: number): Promise<PRReviewResult | null> => {
      if (!isValidPrId(prId)) return null;
      return withProjectOrNull(projectId, async (project) => getBitbucketReviewResult(project, prId));
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.BITBUCKET_PR_GET_LOGS,
    async (
      _event,
      projectId: string,
      prId: number,
      known?: PRLogsKnownVersion
    ): Promise<PRLogs | null | 'unchanged'> => {
      if (!isValidPrId(prId)) return null;
      return withProjectOrNull(projectId, async (project) =>
        loadPRLogsIfChanged(project, prId, known, 'bitbucket')
      );
    }
  );
}
