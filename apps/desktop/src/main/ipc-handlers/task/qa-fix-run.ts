/**
 * zeenha fork: the one place that starts a QA fix run, i.e. the QA process
 * (QALoop: the fixer applies QA_FIX_REQUEST.md, then the reviewer re-reviews).
 *
 * "Request changes" (TASK_REVIEW) starts one. A routed task (per-phase
 * providers) can pause such a run when its QA phase has no usable account
 * (human_review / account_required). Resume used to go through launchTask, so
 * the BuildOrchestrator saw a complete build with the old PASSED qa_report.md,
 * reported "already complete" and dropped the request. Resume now restarts the
 * same QA process instead (TASK_START and a drag to In Progress, via
 * findPendingQAFixResume and resumeQAFixRun). A PR follow-up resumed this way
 * also exits as a qa-process, so finalizePRFollowUp still pushes it
 * (PR_FOLLOWUP.json is left untouched; see resetStalePRFollowUpSignoff).
 */
import path from 'path';
import { AUTO_BUILD_PATHS, getSpecsDir } from '../../../shared/constants';
import type { Project, Task } from '../../../shared/types';
import type { AgentManager } from '../../agent';
import { appLog } from '../../app-logger';
import { taskStateManager } from '../../task-state-manager';
import { findTaskWorktree } from '../../worktree-paths';
import { writeFileAtomicSync } from '../../utils/atomic-file';
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

/** `reported`: the agent manager already sent this failure to the renderer (its 'error' event). */
export type QAFixRunStart = { started: true } | { started: false; error: string; reported: boolean };

/**
 * Start the QA process for a task and, once it is running, move its state
 * machine back to running (USER_RESUMED). If the process does not start, the
 * task is left where it was and the error is returned for the caller to report.
 * USER_RESUMED after the await is safe: spawnWorkerProcess resolves right after
 * the worker is created, before any of its messages are handled.
 */
export async function startQAFixRun(
  agentManager: Pick<AgentManager, 'startQAProcess' | 'isRunning'>,
  task: Task,
  project: Project,
  qaProjectPath: string,
  logTag: string
): Promise<QAFixRunStart> {
  // Clear stale tracking state before starting the new QA process
  taskStateManager.prepareForRestart(task.id);
  appLog.info(`${logTag} Starting QA process with projectPath:`, qaProjectPath);
  try {
    await agentManager.startQAProcess(task.id, qaProjectPath, task.specId, project.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appLog.error(`${logTag} Failed to start QA process for ${task.id}:`, error);
    return { started: false, error: `Could not start QA: ${message}`, reported: false };
  }
  // startQAProcess returns without starting (and emits its own 'error', which
  // reaches the renderer as TASK_ERROR) when auth is missing or no worktree exists
  // under PR-only landing.
  if (!agentManager.isRunning(task.id)) {
    return { started: false, error: 'QA did not start.', reported: true };
  }
  if (task.status === 'queue') {
    taskStateManager.handleManualStatusChange(task.id, 'in_progress', task, project);
  } else {
    taskStateManager.handleUiEvent(task.id, { type: 'USER_RESUMED' }, task, project);
  }
  return { started: true };
}

/** Text TASK_REVIEW writes for "Request changes". The reviewer's template (prompts/qa_reviewer.md) has no such section. */
function isRequestChangesText(content: string): boolean {
  return /^## Feedback[ \t]*$/m.test(content);
}

interface PRFollowUpMarker {
  status?: unknown;
  qaSignoffBefore?: unknown;
}

function readRunningPRFollowUp(specDir: string): PRFollowUpMarker | null {
  const raw = safeReadFileSync(path.join(specDir, PR_FOLLOWUP_MARKER_FILE));
  if (!raw) return null;
  try {
    const marker = JSON.parse(raw) as PRFollowUpMarker;
    return marker?.status === 'running' ? marker : null;
  } catch {
    return null;
  }
}

/**
 * A PR follow-up whose fixer finished before the pause has no QA_FIX_REQUEST.md
 * left. If qa_signoff is still the one recorded when the follow-up started
 * (PR_FOLLOWUP.json qaSignoffBefore, usually the earlier "approved"), QALoop
 * would stop at "Build already approved" without reviewing, and
 * finalizePRFollowUp would find no fresh approval and never push. Mark it
 * "fixes_applied" (what prompts/qa_fixer.md has the fixer write) so QA reviews.
 *
 * This must happen before the QA process starts: startQAProcess copies the plan
 * into the reviewer's first message, and the worker reads qa_signoff as soon as
 * it runs. Returns an undo for when the process does not start, or null when
 * nothing was changed.
 */
function resetStalePRFollowUpSignoff(specDir: string, logTag: string): (() => void) | null {
  const marker = readRunningPRFollowUp(specDir);
  if (!marker || typeof marker.qaSignoffBefore !== 'string') return null;
  if (safeReadFileSync(path.join(specDir, FIX_REQUEST_FILE)) !== null) return null;
  const planPath = path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
  const raw = safeReadFileSync(planPath);
  if (!raw) return null;
  try {
    const plan = JSON.parse(raw) as { qa_signoff?: unknown };
    if (plan.qa_signoff === undefined || plan.qa_signoff === null) return null;
    if (JSON.stringify(plan.qa_signoff) !== marker.qaSignoffBefore) return null;
    const original = plan.qa_signoff;
    const reset = { status: 'fixes_applied', timestamp: new Date().toISOString() };
    plan.qa_signoff = reset;
    writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));
    appLog.info(`${logTag} Reset the pre-follow-up qa_signoff so QA re-reviews the PR follow-up`);
    return () => restoreSignoff(planPath, reset, original, logTag);
  } catch (error) {
    appLog.warn(`${logTag} Could not reset the stale qa_signoff at ${planPath}:`, error);
    return null;
  }
}

/** Put the original qa_signoff back, unless something replaced the reset one meanwhile. */
function restoreSignoff(planPath: string, reset: unknown, original: unknown, logTag: string): void {
  const raw = safeReadFileSync(planPath);
  if (!raw) return;
  try {
    const plan = JSON.parse(raw) as { qa_signoff?: unknown };
    if (JSON.stringify(plan.qa_signoff) !== JSON.stringify(reset)) return;
    plan.qa_signoff = original;
    writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));
  } catch (error) {
    appLog.warn(`${logTag} Could not restore the qa_signoff at ${planPath}:`, error);
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
  if (task.status !== 'queue' && !(task.status === 'human_review' && task.reviewReason === 'account_required')) return null;
  const target = resolveQAFixTarget(project, task);
  if (!buildIsComplete(target.specDir)) return null;
  const request = safeReadFileSync(path.join(target.specDir, FIX_REQUEST_FILE));
  if (request !== null && isRequestChangesText(request)) return target;
  if (readRunningPRFollowUp(target.specDir)) return target;
  return null;
}

/**
 * Resume a QA fix run found by findPendingQAFixResume: the QA process, never
 * launchTask. Used by every path that relaunches a paused task (TASK_START and a
 * drag to In Progress).
 */
export async function resumeQAFixRun(
  agentManager: Pick<AgentManager, 'startQAProcess' | 'isRunning'>,
  task: Task,
  project: Project,
  target: QAFixTarget,
  logTag: string
): Promise<QAFixRunStart> {
  const undoSignoffReset = resetStalePRFollowUpSignoff(target.specDir, logTag);
  const result = await startQAFixRun(agentManager, task, project, target.qaProjectPath, logTag);
  // Nothing runs, so the task stays exactly as it was paused.
  if (!result.started) undoSignoffReset?.();
  return result;
}
