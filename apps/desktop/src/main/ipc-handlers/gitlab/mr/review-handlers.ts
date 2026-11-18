/**
 * GitLab MR review handlers: diff, saved review, run/follow-up/cancel review,
 * and the new-commits check. Thin adapters over review-runner.
 */

import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import path from 'path';
import fs from 'fs';
import { IPC_CHANNELS } from '../../../../shared/constants';
import { getGitLabConfig, gitlabFetch, encodeProjectPath } from '../utils';
import type { MRReviewResult, NewCommitsCheck } from '../types';
import { createContextLogger } from '../../github/utils/logger';
import { withProjectOrNull } from '../../github/utils/project-middleware';
import { getGitLabDir, getReviewResult } from './review-results';
import { runMRReview, runningReviews, getReviewKey, reviewChannels } from './review-runner';

const { debug: debugLog } = createContextLogger('GitLab MR');

/**
 * Start an initial or follow-up review and report progress, result and errors to the renderer.
 */
async function startReview(
  getMainWindow: () => BrowserWindow | null,
  projectId: string,
  mrIid: number,
  { followup }: { followup: boolean }
): Promise<void> {
  debugLog('startReview handler called', { projectId, mrIid, followup });
  const mainWindow = getMainWindow();
  if (!mainWindow) {
    debugLog('No main window available');
    return;
  }

  const { sendProgress, sendError, sendComplete } = reviewChannels(mainWindow, projectId);

  try {
    await withProjectOrNull(projectId, async (project) => {
      if (runningReviews.has(getReviewKey(projectId, mrIid))) {
        debugLog('Review already running', { projectId, mrIid });
        return;
      }

      if (followup) {
        sendProgress({ phase: 'fetching', mrIid, progress: 5, message: 'Starting follow-up review...' });
      } else {
        debugLog('Starting MR review', { mrIid });
        sendProgress({ phase: 'fetching', mrIid, progress: 5, message: 'Assigning you to MR...' });

        // Auto-assign current user to MR
        const config = await getGitLabConfig(project);
        if (config) {
          try {
            const encodedProject = encodeProjectPath(config.project);
            const user = await gitlabFetch(config.token, config.instanceUrl, '/user') as { id: number; username: string };
            debugLog('Auto-assigning user to MR', { mrIid, username: user.username });

            await gitlabFetch(
              config.token,
              config.instanceUrl,
              `/projects/${encodedProject}/merge_requests/${mrIid}`,
              {
                method: 'PUT',
                body: JSON.stringify({ assignee_ids: [user.id] }),
              }
            );
            debugLog('User assigned successfully', { mrIid, username: user.username });
          } catch (assignError) {
            debugLog('Failed to auto-assign user', { mrIid, error: assignError instanceof Error ? assignError.message : assignError });
          }
        }

        sendProgress({ phase: 'fetching', mrIid, progress: 10, message: 'Fetching MR data...' });
      }

      const result = await runMRReview(project, mrIid, mainWindow, { followup });
      if (!result) return;

      debugLog('MR review completed', { mrIid, followup, findingsCount: result.findings.length });
      sendProgress({
        phase: 'complete',
        mrIid,
        progress: 100,
        message: followup ? 'Follow-up review complete!' : 'Review complete!',
      });
      sendComplete(result);
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    debugLog('MR review failed', { mrIid, followup, error: errorMessage });
    sendError({
      mrIid,
      error: `${followup ? 'Follow-up review' : 'MR review'} failed for MR #${mrIid}: ${errorMessage}`,
    });
  }
}

/**
 * Register MR review handlers
 */
export function registerMRReviewRunHandlers(
  getMainWindow: () => BrowserWindow | null
): void {

  // Get MR diff (feature parity with GitHub PR diff)
  ipcMain.handle(
    IPC_CHANNELS.GITLAB_MR_GET_DIFF,
    async (_, projectId: string, mrIid: number): Promise<string | null> => {
      return withProjectOrNull(projectId, async (project) => {
        const config = await getGitLabConfig(project);
        if (!config) return null;

        try {
          // Validate mrIid
          if (!Number.isInteger(mrIid) || mrIid <= 0) {
            throw new Error('Invalid MR IID');
          }

          const encodedProject = encodeProjectPath(config.project);
          const diff = await gitlabFetch(
            config.token,
            config.instanceUrl,
            `/projects/${encodedProject}/merge_requests/${mrIid}/changes`
          ) as { changes: Array<{ diff: string }> };

          // Combine all file diffs
          return diff.changes.map(c => c.diff).join('\n');
        } catch (error) {
          debugLog('Failed to get MR diff', { mrIid, error: error instanceof Error ? error.message : error });
          return null;
        }
      });
    }
  );

  // Get saved review
  ipcMain.handle(
    IPC_CHANNELS.GITLAB_MR_GET_REVIEW,
    async (_, projectId: string, mrIid: number): Promise<MRReviewResult | null> => {
      return withProjectOrNull(projectId, async (project) => {
        return getReviewResult(project, mrIid);
      });
    }
  );

  // Run AI review
  ipcMain.on(
    IPC_CHANNELS.GITLAB_MR_REVIEW,
    (_, projectId: string, mrIid: number) => startReview(getMainWindow, projectId, mrIid, { followup: false })
  );

  // Run follow-up review
  ipcMain.on(
    IPC_CHANNELS.GITLAB_MR_FOLLOWUP_REVIEW,
    (_, projectId: string, mrIid: number) => startReview(getMainWindow, projectId, mrIid, { followup: true })
  );

  // Cancel MR review
  ipcMain.handle(
    IPC_CHANNELS.GITLAB_MR_REVIEW_CANCEL,
    async (_, projectId: string, mrIid: number): Promise<boolean> => {
      debugLog('cancelMRReview handler called', { projectId, mrIid });
      const reviewKey = getReviewKey(projectId, mrIid);
      const abortController = runningReviews.get(reviewKey);

      if (!abortController) {
        debugLog('No running review found to cancel', { reviewKey });
        return false;
      }

      try {
        debugLog('Aborting MR review', { reviewKey });
        abortController.abort();
        runningReviews.delete(reviewKey);
        debugLog('Review aborted', { reviewKey });
        return true;
      } catch (error) {
        debugLog('Failed to cancel review', { reviewKey, error: error instanceof Error ? error.message : error });
        return false;
      }
    }
  );

  // Check for new commits since last review
  ipcMain.handle(
    IPC_CHANNELS.GITLAB_MR_CHECK_NEW_COMMITS,
    async (_, projectId: string, mrIid: number): Promise<NewCommitsCheck> => {
      debugLog('checkNewCommits handler called', { projectId, mrIid });

      const result = await withProjectOrNull(projectId, async (project) => {
        const gitlabDir = getGitLabDir(project);
        const reviewPath = path.join(gitlabDir, 'mr', `review_${mrIid}.json`);

        if (!fs.existsSync(reviewPath)) {
          return { hasNewCommits: false };
        }

        let review: MRReviewResult;
        try {
          const data = fs.readFileSync(reviewPath, 'utf-8');
          review = JSON.parse(data);
        } catch {
          return { hasNewCommits: false };
        }

        const reviewedCommitSha = review.reviewedCommitSha || (review as any).reviewed_commit_sha;
        if (!reviewedCommitSha) {
          debugLog('No reviewedCommitSha in review', { mrIid });
          return { hasNewCommits: false };
        }

        const config = await getGitLabConfig(project);
        if (!config) {
          return { hasNewCommits: false };
        }

        try {
          const encodedProject = encodeProjectPath(config.project);
          const mrData = await gitlabFetch(
            config.token,
            config.instanceUrl,
            `/projects/${encodedProject}/merge_requests/${mrIid}`
          ) as { sha: string; diff_refs: { head_sha: string } };

          const currentHeadSha = mrData.sha || mrData.diff_refs?.head_sha;

          if (reviewedCommitSha === currentHeadSha) {
            return {
              hasNewCommits: false,
              currentSha: currentHeadSha,
              reviewedSha: reviewedCommitSha,
            };
          }

          // Get commits to count new ones
          const commits = await gitlabFetch(
            config.token,
            config.instanceUrl,
            `/projects/${encodedProject}/merge_requests/${mrIid}/commits`
          ) as Array<{ id: string }>;

          // Find how many commits are after the reviewed one
          let newCommitCount = 0;
          for (const commit of commits) {
            if (commit.id === reviewedCommitSha) break;
            newCommitCount++;
          }

          return {
            hasNewCommits: true,
            currentSha: currentHeadSha,
            reviewedSha: reviewedCommitSha,
            newCommitCount: newCommitCount || 1,
          };
        } catch (error) {
          debugLog('Error checking new commits', { mrIid, error: error instanceof Error ? error.message : error });
          return { hasNewCommits: false };
        }
      });

      return result ?? { hasNewCommits: false };
    }
  );

}
