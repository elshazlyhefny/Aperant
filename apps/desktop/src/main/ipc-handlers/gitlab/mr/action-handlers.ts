/**
 * GitLab MR action handlers: merge, assign and approve a merge request.
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../../../shared/constants';
import { getGitLabConfig, gitlabFetch, encodeProjectPath } from '../utils';
import { createContextLogger } from '../../github/utils/logger';
import { withProjectOrNull } from '../../github/utils/project-middleware';

const { debug: debugLog } = createContextLogger('GitLab MR');

const REBASE_POLL_INTERVAL_MS = 1000;
// Default rebase timeout (60 seconds). Can be overridden via GITLAB_REBASE_TIMEOUT_MS env var
const REBASE_TIMEOUT_MS = parseInt(process.env.GITLAB_REBASE_TIMEOUT_MS || '60000', 10);

async function waitForRebaseCompletion(
  token: string,
  instanceUrl: string,
  encodedProject: string,
  mrIid: number
): Promise<void> {
  const deadline = Date.now() + REBASE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const mrData = await gitlabFetch(
      token,
      instanceUrl,
      `/projects/${encodedProject}/merge_requests/${mrIid}`
    ) as { rebase_in_progress?: boolean };

    if (!mrData.rebase_in_progress) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, REBASE_POLL_INTERVAL_MS));
  }

  throw new Error('Rebase did not complete before timeout');
}

/**
 * Register MR action handlers
 */
export function registerMRActionHandlers(): void {
  // Merge MR
  ipcMain.handle(
    IPC_CHANNELS.GITLAB_MR_MERGE,
    async (_, projectId: string, mrIid: number, mergeMethod: 'merge' | 'squash' | 'rebase' = 'squash'): Promise<boolean> => {
      debugLog('mergeMR handler called', { projectId, mrIid, mergeMethod });
      const mergeResult = await withProjectOrNull(projectId, async (project) => {
        const config = await getGitLabConfig(project);
        if (!config) return false;

        try {
          // Validate mrIid
          if (!Number.isInteger(mrIid) || mrIid <= 0) {
            throw new Error('Invalid MR IID');
          }

          const encodedProject = encodeProjectPath(config.project);

          // Determine merge options based on method
          const mergeOptions: Record<string, unknown> = {};
          if (mergeMethod === 'squash') {
            mergeOptions.squash = true;
          } else if (mergeMethod === 'rebase') {
            debugLog('Rebasing MR before merge', { mrIid });
            await gitlabFetch(
              config.token,
              config.instanceUrl,
              `/projects/${encodedProject}/merge_requests/${mrIid}/rebase`,
              { method: 'POST' }
            );
            await waitForRebaseCompletion(
              config.token,
              config.instanceUrl,
              encodedProject,
              mrIid
            );
          }

          debugLog('Merging MR', { mrIid, method: mergeMethod, options: mergeOptions });

          await gitlabFetch(
            config.token,
            config.instanceUrl,
            `/projects/${encodedProject}/merge_requests/${mrIid}/merge`,
            {
              method: 'PUT',
              body: JSON.stringify(mergeOptions),
            }
          );

          debugLog('MR merged successfully', { mrIid });
          return true;
        } catch (error) {
          debugLog('Failed to merge MR', { mrIid, error: error instanceof Error ? error.message : error });
          return false;
        }
      });
      return mergeResult ?? false;
    }
  );

  // Assign users to MR
  ipcMain.handle(
    IPC_CHANNELS.GITLAB_MR_ASSIGN,
    async (_, projectId: string, mrIid: number, userIds: number[]): Promise<boolean> => {
      debugLog('assignMR handler called', { projectId, mrIid, userIds });
      const assignResult = await withProjectOrNull(projectId, async (project) => {
        const config = await getGitLabConfig(project);
        if (!config) return false;

        try {
          const encodedProject = encodeProjectPath(config.project);
          await gitlabFetch(
            config.token,
            config.instanceUrl,
            `/projects/${encodedProject}/merge_requests/${mrIid}`,
            {
              method: 'PUT',
              body: JSON.stringify({ assignee_ids: userIds }),
            }
          );
          debugLog('Users assigned successfully', { mrIid, userIds });
          return true;
        } catch (error) {
          debugLog('Failed to assign users', { mrIid, userIds, error: error instanceof Error ? error.message : error });
          return false;
        }
      });
      return assignResult ?? false;
    }
  );

  // Approve MR
  ipcMain.handle(
    IPC_CHANNELS.GITLAB_MR_APPROVE,
    async (_, projectId: string, mrIid: number): Promise<boolean> => {
      debugLog('approveMR handler called', { projectId, mrIid });
      const approveResult = await withProjectOrNull(projectId, async (project) => {
        const config = await getGitLabConfig(project);
        if (!config) return false;

        try {
          const encodedProject = encodeProjectPath(config.project);
          await gitlabFetch(
            config.token,
            config.instanceUrl,
            `/projects/${encodedProject}/merge_requests/${mrIid}/approve`,
            {
              method: 'POST',
            }
          );
          debugLog('MR approved successfully', { mrIid });
          return true;
        } catch (error) {
          debugLog('Failed to approve MR', { mrIid, error: error instanceof Error ? error.message : error });
          return false;
        }
      });
      return approveResult ?? false;
    }
  );
}
