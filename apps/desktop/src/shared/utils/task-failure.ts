/**
 * zeenha fork: telling a task that FAILED before doing any work apart from one
 * that failed AFTER real work.
 *
 * Both end in the XState `error` state. Until this, both were shown as Human
 * Review with a red "Has Errors" badge, so a task whose planning or first
 * coding step failed looked finished and offered Create PR, which then found
 * no changes. A task that failed before any work is now status `error` (the
 * board's Failed column); one that failed after real work (for example QA hit
 * its iteration limit on code that was written) stays in Human Review.
 *
 * This is the ONE definition of the rule. The main process uses it when the
 * state machine enters `error` (task-state-manager) and when tasks are read
 * from disk (project-store), so tasks persisted before this change are shown
 * the same way as new ones.
 */
import type { ReviewReason, TaskStatus } from '../types';

export interface TaskFailureFacts {
  /** XState state name, when known (the live machine, or `xstateState` on disk). */
  xstateState?: string;
  /** Legacy task status, as persisted or as currently shown. */
  status?: TaskStatus;
  reviewReason?: ReviewReason;
  /** Persisted execution phase; `failed` is what the machine's `error` state writes. */
  executionPhase?: string;
  /** Every subtask status known for the task (main plan and worktree plan together). */
  subtasks: ReadonlyArray<{ status?: string }>;
  /**
   * Whether the task's workspace holds code changes: commits on the task branch
   * or uncommitted edits outside `.auto-claude`. `null` when it could not be
   * determined (a git error, or the task ran without a worktree).
   */
  hasCodeChanges: boolean | null;
}

/**
 * True when the task's run ended in failure: the machine is in `error`, the
 * task is already shown as failed, or it was persisted as Human Review
 * "errors" by a failed run (executionPhase `failed`). A Human Review "errors"
 * task without a failed phase is not a failed run (for example a task whose
 * plan file could not be parsed).
 */
export function isFailedRun(facts: Pick<TaskFailureFacts, 'xstateState' | 'status' | 'reviewReason' | 'executionPhase'>): boolean {
  if (facts.xstateState === 'error') return true;
  if (facts.status === 'error') return true;
  return facts.status === 'human_review' && facts.reviewReason === 'errors' && facts.executionPhase === 'failed';
}

/**
 * The rule: a failed run did no work when NO subtask is completed AND the
 * workspace is known to hold no code changes. Unknown changes (`null`) count
 * as work, so an undetermined task keeps the old Human Review behaviour rather
 * than hiding work the user may need to review.
 */
export function failedBeforeAnyWork(facts: TaskFailureFacts): boolean {
  if (!isFailedRun(facts)) return false;
  if (facts.subtasks.some((s) => s.status === 'completed')) return false;
  return facts.hasCodeChanges === false;
}

/**
 * Status/reviewReason for a failed run: `error` (Failed column) when it did
 * no work, Human Review "errors" otherwise. Returns null when the task is not
 * a failed run, so callers leave its status alone.
 */
export function failedRunStatus(
  facts: TaskFailureFacts
): { status: TaskStatus; reviewReason?: ReviewReason } | null {
  if (!isFailedRun(facts)) return null;
  return failedBeforeAnyWork(facts)
    ? { status: 'error' }
    : { status: 'human_review', reviewReason: 'errors' };
}

const FAILED_PHASE_MESSAGE = /^Failed [a-z_]+ phase: ([\s\S]+)$/;

/**
 * The reason inside a task log `phase_end` message ("Failed planning phase:
 * <reason>", written by phaseEndMessage). Undefined for any other message,
 * including the bare "Failed planning phase" written before reasons were kept.
 */
export function reasonFromPhaseEndMessage(content: string | undefined): string | undefined {
  if (!content) return undefined;
  const match = FAILED_PHASE_MESSAGE.exec(content.trim());
  const reason = match?.[1]?.trim();
  return reason ? reason : undefined;
}

/**
 * Where a task in the Failed column (status `error`) may be moved by hand.
 * Backlog (park it; the state machine leaves `error` and drops the reason),
 * Queue and In Progress (run it again, like Retry) and Done (give it up) are
 * real moves. AI Review and Human Review are refused: the task did no work, so
 * there is nothing to review, and showing it there is the defect the Failed
 * column exists to remove.
 */
const FAILED_TASK_TARGETS: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['backlog', 'queue', 'in_progress', 'done']);

export function canMoveFailedTaskTo(target: TaskStatus): boolean {
  return FAILED_TASK_TARGETS.has(target);
}
