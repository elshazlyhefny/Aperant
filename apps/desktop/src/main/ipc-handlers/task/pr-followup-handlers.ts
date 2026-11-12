/**
 * zeenha fork: send a task's failing CI checks and unresolved PR review
 * feedback back to the task's own worktree as a follow-up QA run.
 *
 * Two entry points:
 * - TASK_PR_FEEDBACK_GET is read-only. It never starts anything.
 * - TASK_PR_FOLLOWUP_START is the only place a run starts. The renderer sends
 *   item IDs only. Main re-fetches the feedback from GitHub and builds the
 *   request text itself, so renderer-supplied text can never reach the agent.
 */

import { ipcMain } from 'electron';
import path from 'path';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import type { AgentManager } from '../../agent';
import { IPC_CHANNELS, getSpecsDir, AUTO_BUILD_PATHS } from '../../../shared/constants';
import type {
  IPCResult,
  Project,
  Task,
  PRFeedbackBlockedReason,
  PRFeedbackItem,
  PRFeedbackResult,
  StartPRFollowUpResult,
} from '../../../shared/types';
import { findTaskAndProject } from './shared';
import { getGitHubConfig } from '../github/utils';
import {
  fetchPRFeedback,
  parsePRNumberFromUrl,
  PRFeedbackError,
  type PRFeedbackFetchResult,
} from '../github/pr/task-feedback';
import { buildFollowUpRequest } from './pr-followup-request';
import { findTaskWorktree } from '../../worktree-paths';
import { getToolPath } from '../../cli-tool-manager';
import { getIsolatedGitEnv } from '../../utils/git-isolation';
import { initializeClaudeProfileManager } from '../../claude-profile-manager';
import { readSettingsFile } from '../../settings-utils';
import { taskStateManager } from '../../task-state-manager';

export const PR_FOLLOWUP_MARKER = 'PR_FOLLOWUP.json';
export const MAX_FOLLOWUP_ITEMS = 100;
const ITEM_ID_FORMAT = /^(?:check|review_thread|thread|review):[A-Za-z0-9_\-=:.]{1,200}$/;

export type PRFollowUpErrorCode = PRFeedbackBlockedReason | 'no_open_pr' | 'invalid_items' | 'fetch_failed' | 'start_failed';

export type PRFollowUpIPCResult<T> = IPCResult<T> & { code?: PRFollowUpErrorCode };

const BLOCKED_MESSAGES: Record<PRFeedbackBlockedReason, string> = {
  worktree_missing:
    "This task's worktree no longer exists (it is removed after a merge or a cleanup), so the follow-up cannot run there. Nothing was started and nothing was changed. Make the fixes by hand on the branch, or create a new task for them.",
  pr_not_open: 'The pull request is closed or merged, so feedback cannot be sent back to this task. Nothing was started.',
  agent_running: 'An agent is already running for this task. Wait for it to finish, then try again. Nothing was started.',
  auth_required: 'Authentication required. Add an account in Settings > Accounts, then try again. Nothing was started.',
  no_github_config: 'GitHub is not configured for this project (token or repository missing). Nothing was started.',
  branch_mismatch:
    "The task's worktree is not on the pull request branch, so the follow-up cannot push to the same PR. Nothing was started.",
};

interface TaskPRContext {
  task: Task;
  project: Project;
  prUrl: string;
  prNumber: number;
}

type Resolved =
  | { ok: true; ctx: TaskPRContext }
  | { ok: false; code: PRFollowUpErrorCode; error: string };

function resolveTask(taskId: string): Resolved {
  const { task, project } = findTaskAndProject(taskId);
  if (!task || !project) return { ok: false, code: 'no_open_pr', error: 'Task or project not found' };
  const prUrl = task.metadata?.prUrl;
  if ((task.status !== 'pr_created' && task.status !== 'done') || !prUrl) {
    return { ok: false, code: 'no_open_pr', error: 'This task has no open pull request.' };
  }
  const prNumber = parsePRNumberFromUrl(prUrl);
  if (!prNumber) return { ok: false, code: 'no_open_pr', error: 'The pull request link of this task is not valid.' };
  return { ok: true, ctx: { task, project, prUrl, prNumber } };
}

type WorktreeCheck =
  | { available: true; path: string }
  | { available: false; reason: 'missing' | 'not_a_worktree' | 'branch_mismatch' };

function currentBranch(worktreePath: string): string | null {
  try {
    return execFileSync(getToolPath('git'), ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 15000,
      env: getIsolatedGitEnv(),
    }).trim();
  } catch {
    return null;
  }
}

function checkWorktree(project: Project, task: Task): WorktreeCheck {
  const wt = findTaskWorktree(project.path, task.specId);
  if (!wt || !existsSync(wt)) return { available: false, reason: 'missing' };
  if (!existsSync(path.join(wt, '.git'))) return { available: false, reason: 'not_a_worktree' };
  if (currentBranch(wt) !== `auto-claude/${task.specId}`) return { available: false, reason: 'branch_mismatch' };
  return { available: true, path: wt };
}

function hasAuth(profileManager: { hasValidAuth(): boolean }): boolean {
  if (profileManager.hasValidAuth()) return true;
  const accounts = readSettingsFile()?.providerAccounts ?? [];
  return accounts.length > 0;
}

async function checkAuth(): Promise<boolean> {
  try {
    return hasAuth(await initializeClaudeProfileManager());
  } catch {
    return false;
  }
}

/** First reason (in priority order) the follow-up cannot start, or undefined. */
function firstBlock(args: {
  worktree: WorktreeCheck;
  prState: PRFeedbackResult['prState'];
  headRef: string;
  specId: string;
  running: boolean;
  auth: boolean;
}): PRFeedbackBlockedReason | undefined {
  if (!args.worktree.available) {
    return args.worktree.reason === 'branch_mismatch' ? 'branch_mismatch' : 'worktree_missing';
  }
  if (args.prState !== 'open') return 'pr_not_open';
  if (args.headRef !== `auto-claude/${args.specId}`) return 'branch_mismatch';
  if (args.running) return 'agent_running';
  if (!args.auth) return 'auth_required';
  return undefined;
}

function feedbackErrorMessage(error: unknown): string {
  return error instanceof PRFeedbackError ? error.message : 'Failed to load pull request feedback from GitHub';
}

function allItems(f: Pick<PRFeedbackFetchResult, 'checks' | 'threads' | 'reviews'>): PRFeedbackItem[] {
  return [...f.checks, ...f.threads, ...f.reviews];
}

function readRawQASignoff(planPath: string): string | null {
  try {
    const plan = JSON.parse(readFileSync(planPath, 'utf-8')) as { qa_signoff?: unknown };
    if (plan.qa_signoff === undefined || plan.qa_signoff === null) return null;
    return JSON.stringify(plan.qa_signoff);
  } catch {
    return null;
  }
}

export function registerPRFollowUpHandlers(agentManager: AgentManager): void {
  ipcMain.handle(
    IPC_CHANNELS.TASK_PR_FEEDBACK_GET,
    async (_, taskId: string): Promise<PRFollowUpIPCResult<PRFeedbackResult>> => {
      const resolved = resolveTask(String(taskId));
      if (!resolved.ok) return { success: false, code: resolved.code, error: resolved.error };
      const { task, project, prNumber } = resolved.ctx;

      const config = getGitHubConfig(project);
      if (!config) return { success: false, code: 'no_github_config', error: BLOCKED_MESSAGES.no_github_config };

      let fetched: PRFeedbackFetchResult;
      try {
        fetched = await fetchPRFeedback(config, prNumber);
      } catch (error) {
        return { success: false, code: 'fetch_failed', error: feedbackErrorMessage(error) };
      }

      const worktree = checkWorktree(project, task);
      const blockedReason = firstBlock({
        worktree,
        prState: fetched.prState,
        headRef: fetched.headRef,
        specId: task.specId,
        running: agentManager.isRunning(task.id),
        auth: await checkAuth(),
      });

      return {
        success: true,
        data: {
          ...fetched,
          worktree: worktree.available ? { available: true } : { available: false, reason: worktree.reason },
          canStartFollowUp: blockedReason === undefined,
          ...(blockedReason ? { blockedReason } : {}),
          fetchedAt: new Date().toISOString(),
        },
      };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.TASK_PR_FOLLOWUP_START,
    async (_, taskId: string, itemIds: unknown): Promise<PRFollowUpIPCResult<StartPRFollowUpResult>> => {
      // 1. Validate input (IDs only).
      if (
        !Array.isArray(itemIds) ||
        itemIds.length === 0 ||
        itemIds.length > MAX_FOLLOWUP_ITEMS ||
        !itemIds.every((id) => typeof id === 'string' && ITEM_ID_FORMAT.test(id))
      ) {
        return { success: false, code: 'invalid_items', error: 'Select at least one valid feedback item. Nothing was started.' };
      }
      const selected = new Set<string>(itemIds as string[]);

      // 2. Re-run the preconditions. Nothing is written or changed before they pass.
      const resolved = resolveTask(String(taskId));
      if (!resolved.ok) return { success: false, code: resolved.code, error: resolved.error };
      const { task, project, prUrl, prNumber } = resolved.ctx;

      const worktree = checkWorktree(project, task);
      if (!worktree.available) {
        const code: PRFeedbackBlockedReason = worktree.reason === 'branch_mismatch' ? 'branch_mismatch' : 'worktree_missing';
        return { success: false, code, error: BLOCKED_MESSAGES[code] };
      }
      const worktreePath = worktree.path;

      const config = getGitHubConfig(project);
      if (!config) return { success: false, code: 'no_github_config', error: BLOCKED_MESSAGES.no_github_config };

      // 3. Re-fetch in main. Only selected items are kept; unknown ids are rejected.
      let fetched: PRFeedbackFetchResult;
      try {
        fetched = await fetchPRFeedback(config, prNumber);
      } catch (error) {
        return { success: false, code: 'fetch_failed', error: feedbackErrorMessage(error) };
      }

      const blocked = firstBlock({
        worktree,
        prState: fetched.prState,
        headRef: fetched.headRef,
        specId: task.specId,
        running: agentManager.isRunning(task.id),
        auth: await checkAuth(),
      });
      if (blocked) return { success: false, code: blocked, error: BLOCKED_MESSAGES[blocked] };

      const items = allItems(fetched);
      const known = new Set(items.map((i) => i.id));
      if ([...selected].some((id) => !known.has(id))) {
        return {
          success: false,
          code: 'invalid_items',
          error: 'Some selected items no longer exist on the pull request. Refresh and select again. Nothing was started.',
        };
      }
      const chosen = items.filter((i) => selected.has(i.id));

      // 4. Build the request in main and write the marker + request into the worktree spec dir.
      const requestText = buildFollowUpRequest(chosen, { prUrl, prNumber, branch: fetched.headRef });
      const specDir = path.join(worktreePath, getSpecsDir(project.autoBuildPath), task.specId);
      const markerPath = path.join(specDir, PR_FOLLOWUP_MARKER);
      const requestPath = path.join(specDir, 'QA_FIX_REQUEST.md');
      // A stale marker with status 'running' is simply overwritten: the agent-running
      // check above already proved no run is active.
      const marker = {
        version: 1,
        prUrl,
        prNumber,
        branch: fetched.headRef,
        headShaAtStart: fetched.headSha,
        selectedItemIds: chosen.map((i) => i.id),
        startedAt: new Date().toISOString(),
        qaSignoffBefore: readRawQASignoff(path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN)),
        status: 'running',
      };

      try {
        mkdirSync(specDir, { recursive: true });
        writeFileSync(markerPath, JSON.stringify(marker, null, 2), 'utf-8');
        writeFileSync(requestPath, requestText, 'utf-8');

        taskStateManager.prepareForRestart(task.id);
        taskStateManager.startPRFollowUp(task.id, task, project);
        await agentManager.startQAProcess(task.id, worktreePath, task.specId, project.id);
      } catch (error) {
        // No partial run: remove what was written and drop the rebuilt actor.
        try { rmSync(markerPath, { force: true }); } catch { /* best effort */ }
        try { rmSync(requestPath, { force: true }); } catch { /* best effort */ }
        try { taskStateManager.clearTask(task.id); } catch { /* best effort */ }
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, code: 'start_failed', error: `Could not start the follow-up: ${message}. Nothing was started.` };
      }

      return { success: true, data: { started: true, itemCount: chosen.length } };
    }
  );
}
