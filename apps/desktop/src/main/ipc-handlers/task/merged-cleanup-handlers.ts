/**
 * zeenha fork: remove worktrees whose PR has merged.
 *
 * Runs a minute after start, then every 15 minutes, and on demand from the
 * Worktrees page (when it opens and from its "Clean up merged" button). All
 * the checks are in main/worktree-auto-cleanup.ts.
 */

import { ipcMain } from 'electron';
import type { AgentManager } from '../../agent';
import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult, MergedCleanupOutcome } from '../../../shared/types';
import { projectStore } from '../../project-store';
import { cleanupWorktree } from '../../utils/worktree-cleanup';
import { findTaskWorktree } from '../../worktree-paths';
import { dockerVolumesForWorktree, removeDockerVolumes } from '../../worktree-docker-volumes';
import {
  MERGED_CLEANUP_FIRST_RUN_MS,
  MERGED_CLEANUP_INTERVAL_MS,
  type MergedCleanupDeps,
  branchTipInRepo,
  commitIsInPullRequest,
  deleteTaskBranch,
  ensureWorktreeDeletable,
  readPullRequestState,
  runMergedWorktreeCleanup,
  worktreeHasUncommittedChanges,
  worktreeHeadCommit,
  worktreeIsReal,
} from '../../worktree-auto-cleanup';

export function createMergedCleanupDeps(agentManager: AgentManager): MergedCleanupDeps {
  return {
    listProjects: () => projectStore.getProjects(),
    listTasks: (projectId) => projectStore.getTasks(projectId),
    findWorktree: (projectPath, specId) => findTaskWorktree(projectPath, specId),
    isRunning: (taskId) => agentManager.isRunning(taskId),
    prState: readPullRequestState,
    isRealWorktree: worktreeIsReal,
    hasUncommittedChanges: worktreeHasUncommittedChanges,
    headCommit: worktreeHeadCommit,
    branchTip: branchTipInRepo,
    isInPullRequest: commitIsInPullRequest,
    ensureDeletable: ensureWorktreeDeletable,
    // The branch is named explicitly: a leftover folder has no .git to read it from.
    remove: ({ worktreePath, projectPath, specId }) =>
      cleanupWorktree({
        worktreePath,
        projectPath,
        specId,
        logPrefix: '[MERGED_CLEANUP]',
        deleteBranch: true,
        branchName: `auto-claude/${specId}`,
      }),
    dockerVolumesFor: dockerVolumesForWorktree,
    removeDockerVolumes,
    deleteBranch: deleteTaskBranch,
    invalidate: (projectId) => projectStore.invalidateTasksCache(projectId),
  };
}

function logOutcomes(outcomes: MergedCleanupOutcome[]): void {
  for (const o of outcomes) {
    if (o.status === 'removed') console.warn(`[MERGED_CLEANUP] removed worktree ${o.specId} (${o.prUrl})`);
    if (o.status === 'kept') console.warn(`[MERGED_CLEANUP] kept ${o.specId}: ${o.reason}${o.detail ? ` (${o.detail})` : ''}`);
  }
}

let timer: NodeJS.Timeout | null = null;

export function registerMergedCleanupHandlers(agentManager: AgentManager): void {
  const deps = createMergedCleanupDeps(agentManager);

  ipcMain.handle(
    IPC_CHANNELS.TASK_CLEANUP_MERGED_WORKTREES,
    async (_, projectId?: string): Promise<IPCResult<MergedCleanupOutcome[]>> => {
      try {
        const outcomes = await runMergedWorktreeCleanup(deps, projectId ? { projectId } : {});
        logOutcomes(outcomes);
        return { success: true, data: outcomes };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Cleanup failed' };
      }
    },
  );

  const tick = () => {
    runMergedWorktreeCleanup(deps)
      .then(logOutcomes)
      .catch((error) => console.warn('[MERGED_CLEANUP] run failed:', error));
  };
  if (timer) clearInterval(timer);
  setTimeout(() => {
    tick();
    timer = setInterval(tick, MERGED_CLEANUP_INTERVAL_MS);
    timer.unref?.();
  }, MERGED_CLEANUP_FIRST_RUN_MS).unref?.();
}
