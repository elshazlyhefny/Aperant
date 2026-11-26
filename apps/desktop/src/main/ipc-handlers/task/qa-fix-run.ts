/**
 * zeenha fork: the one place that starts a QA fix run, i.e. the QA process
 * (QALoop: the fixer applies QA_FIX_REQUEST.md, then the reviewer re-reviews).
 *
 * "Request changes" (TASK_REVIEW) starts one. A routed task (per-phase
 * providers) can pause such a run when its QA phase has no usable account
 * (human_review / account_required). Resume used to go through launchTask, so
 * the BuildOrchestrator saw a complete build with the old PASSED qa_report.md,
 * reported "already complete" and dropped the request. Resume now restarts the
 * same QA process instead (TASK_START, via findPendingQAFixResume). A PR
 * follow-up resumed this way also exits as a qa-process, so
 * finalizePRFollowUp still pushes it (PR_FOLLOWUP.json is left untouched).
 */
import path from 'path';
import { AUTO_BUILD_PATHS, getSpecsDir } from '../../../shared/constants';
import type { Project, Task } from '../../../shared/types';
import type { AgentManager } from '../../agent';
import { appLog } from '../../app-logger';
import { taskStateManager } from '../../task-state-manager';
import { findTaskWorktree } from '../../worktree-paths';
import { checkSubtasksCompletion, safeReadFileSync } from './launch-task';

/** Same file name as PR_FOLLOWUP_MARKER in pr-followup-handlers.ts (not imported: that module registers IPC). */
const PR_FOLLOWUP_MARKER_FILE = 'PR_FOLLOWUP.json';
const FIX_REQUEST_FILE = 'QA_FIX_REQUEST.md';

export interface QAFixTarget {
  /** Where the QA process runs: the task worktree, or the project when there is none. */
  qaProjectPath: string;
  /** Spec dir the QA process reads QA_FIX_REQUEST.md from. */
  specDir: string;
  worktreePath: string | null;
}

/**
 * Where a QA fix run reads its request and runs: the worktree spec dir when the
 * task has a worktree (the build and its implementation_plan.json live there),
 * otherwise the main project's spec dir.
 */
export function resolveQAFixTarget(project: Project, task: Task): QAFixTarget {
  const specsBaseDir = getSpecsDir(project.autoBuildPath);
  const worktreePath = findTaskWorktree(project.path, task.specId);
  const qaProjectPath = worktreePath ?? project.path;
  return { qaProjectPath, specDir: path.join(qaProjectPath, specsBaseDir, task.specId), worktreePath };
}

/** Start the QA process for a task and move its state machine back to running. */
export function startQAFixRun(
  agentManager: Pick<AgentManager, 'startQAProcess'>,
  task: Task,
  project: Project,
  qaProjectPath: string,
  logTag: string
): void {
  // Clear stale tracking state before starting the new QA process
  taskStateManager.prepareForRestart(task.id);
  appLog.info(`${logTag} Starting QA process with projectPath:`, qaProjectPath);
  Promise.resolve(agentManager.startQAProcess(task.id, qaProjectPath, task.specId, project.id)).catch((error) => {
    appLog.error(`${logTag} Failed to start QA process for ${task.id}:`, error);
  });
  taskStateManager.handleUiEvent(task.id, { type: 'USER_RESUMED' }, task, project);
}

/** Text TASK_REVIEW writes for "Request changes". The reviewer's template (prompts/qa_reviewer.md) has no such section. */
function isRequestChangesText(content: string): boolean {
  return /^## Feedback[ \t]*$/m.test(content);
}

function hasRunningPRFollowUp(specDir: string): boolean {
  const raw = safeReadFileSync(path.join(specDir, PR_FOLLOWUP_MARKER_FILE));
  if (!raw) return false;
  try {
    return (JSON.parse(raw) as { status?: unknown }).status === 'running';
  } catch {
    return false;
  }
}

function buildIsComplete(specDir: string): boolean {
  const raw = safeReadFileSync(path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN));
  if (!raw) return false;
  try {
    return checkSubtasksCompletion(JSON.parse(raw)).allCompleted;
  } catch {
    return false;
  }
}

/**
 * The QA fix run a Resume should restart, or null to resume through launchTask.
 *
 * Only an account pause qualifies (only routed tasks pause this way), and only
 * for a complete build (QALoop refuses an incomplete one). Then it must be a
 * QA-process run that was interrupted:
 * - a "Request changes" QA_FIX_REQUEST.md is still there (QALoop deletes it only
 *   once the fixer completed it), or
 * - a PR follow-up is still running (PR_FOLLOWUP.json status 'running'), even
 *   after its fixer finished, because only a qa-process exit pushes it.
 * A reviewer-written QA_FIX_REQUEST.md alone does not count: the
 * BuildOrchestrator keeps it after its own fixer ran, and restarting QALoop on
 * it would run the fixer again on issues already fixed.
 */
export function findPendingQAFixResume(task: Task, project: Project): QAFixTarget | null {
  if (task.status !== 'human_review' || task.reviewReason !== 'account_required') return null;
  const target = resolveQAFixTarget(project, task);
  if (!buildIsComplete(target.specDir)) return null;
  const request = safeReadFileSync(path.join(target.specDir, FIX_REQUEST_FILE));
  if (request !== null && isRequestChangesText(request)) return target;
  if (hasRunningPRFollowUp(target.specDir)) return target;
  return null;
}
