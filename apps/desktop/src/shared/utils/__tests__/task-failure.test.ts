/**
 * zeenha fork: the one rule that sends a failed run to the Failed column
 * (no work done) or to Human Review (work done).
 */
import { describe, expect, it } from 'vitest';
import { createActor } from 'xstate';
import {
  failedBeforeAnyWork,
  failedRunStatus,
  isFailedRun,
  reasonFromPhaseEndMessage,
  type TaskFailureFacts,
} from '../task-failure';
import { mapStateToLegacy } from '../../state-machines/task-state-utils';
import { taskMachine } from '../../state-machines/task-machine';

const pending = [{ status: 'pending' }, { status: 'pending' }];
const facts = (o: Partial<TaskFailureFacts> = {}): TaskFailureFacts => ({
  xstateState: 'error',
  subtasks: pending,
  hasCodeChanges: false,
  ...o,
});

describe('isFailedRun', () => {
  it('is true for the machine error state and for a task already shown as failed', () => {
    expect(isFailedRun({ xstateState: 'error' })).toBe(true);
    expect(isFailedRun({ status: 'error' })).toBe(true);
  });

  it('recognises a task persisted as Human Review "errors" by a failed run', () => {
    expect(isFailedRun({ status: 'human_review', reviewReason: 'errors', executionPhase: 'failed' })).toBe(true);
  });

  it('is false for Human Review "errors" without a failed phase (a plan that could not be parsed)', () => {
    expect(isFailedRun({ status: 'human_review', reviewReason: 'errors' })).toBe(false);
  });

  it('is false for a real review and for other states', () => {
    expect(isFailedRun({ status: 'human_review', reviewReason: 'completed', executionPhase: 'failed' })).toBe(false);
    expect(isFailedRun({ status: 'human_review', reviewReason: 'qa_rejected' })).toBe(false);
    expect(isFailedRun({ xstateState: 'human_review', status: 'human_review' })).toBe(false);
    expect(isFailedRun({ status: 'done' })).toBe(false);
  });
});

describe('failedBeforeAnyWork', () => {
  it('is true with no completed subtask and no code changes', () => {
    expect(failedBeforeAnyWork(facts())).toBe(true);
    expect(failedBeforeAnyWork(facts({ subtasks: [] }))).toBe(true);
  });

  it('is false once any subtask is completed', () => {
    expect(failedBeforeAnyWork(facts({ subtasks: [{ status: 'completed' }, { status: 'pending' }] }))).toBe(false);
  });

  it('is false when the workspace holds code changes', () => {
    expect(failedBeforeAnyWork(facts({ hasCodeChanges: true }))).toBe(false);
  });

  it('is false when changes are unknown, keeping the old Human Review behaviour', () => {
    expect(failedBeforeAnyWork(facts({ hasCodeChanges: null }))).toBe(false);
  });

  it('is false for a task that is not a failed run', () => {
    expect(failedBeforeAnyWork(facts({ xstateState: 'human_review', status: 'human_review' }))).toBe(false);
  });
});

describe('failedRunStatus', () => {
  it('sends a no-work failure to the Failed column', () => {
    expect(failedRunStatus(facts())).toEqual({ status: 'error' });
  });

  it('keeps a failure after real work in Human Review "errors" (e.g. QA max iterations)', () => {
    expect(failedRunStatus(facts({ subtasks: [{ status: 'completed' }] }))).toEqual({
      status: 'human_review',
      reviewReason: 'errors',
    });
  });

  it('moves a task shown as failed back to Human Review when work turns up', () => {
    expect(failedRunStatus(facts({ xstateState: undefined, status: 'error', hasCodeChanges: true }))).toEqual({
      status: 'human_review',
      reviewReason: 'errors',
    });
  });

  it('leaves tasks that are not a failed run alone', () => {
    expect(failedRunStatus(facts({ xstateState: undefined, status: 'in_progress' }))).toBeNull();
  });
});

describe('reasonFromPhaseEndMessage', () => {
  it('reads the reason after the phase', () => {
    expect(reasonFromPhaseEndMessage('Failed planning phase: Claude Code CLI: 429 rate limit')).toBe(
      'Claude Code CLI: 429 rate limit',
    );
    expect(reasonFromPhaseEndMessage('Failed coding phase: boom')).toBe('boom');
  });

  it('has no reason for the bare message, a success, or nothing', () => {
    expect(reasonFromPhaseEndMessage('Failed planning phase')).toBeUndefined();
    expect(reasonFromPhaseEndMessage('Completed planning phase')).toBeUndefined();
    expect(reasonFromPhaseEndMessage(undefined)).toBeUndefined();
    // only the "<phase> phase: <reason>" format names a reason
    expect(reasonFromPhaseEndMessage('Failed planning phase after retry')).toBeUndefined();
  });
});

describe('mapStateToLegacy for the error state', () => {
  it('maps to the Failed column only when no work was done', () => {
    expect(mapStateToLegacy('error', 'errors', true)).toEqual({ status: 'error' });
    expect(mapStateToLegacy('error', 'errors', false)).toEqual({ status: 'human_review', reviewReason: 'errors' });
    expect(mapStateToLegacy('error')).toEqual({ status: 'human_review', reviewReason: 'errors' });
  });

  it('leaves a real Human Review untouched', () => {
    expect(mapStateToLegacy('human_review', 'completed', true)).toEqual({ status: 'human_review', reviewReason: 'completed' });
  });
});

describe('task machine: leaving the failed state', () => {
  const failedActor = (event: Parameters<ReturnType<typeof createActor<typeof taskMachine>>['send']>[0]) => {
    const actor = createActor(taskMachine).start();
    actor.send({ type: 'PLANNING_STARTED' });
    actor.send(event);
    return actor;
  };

  it('a planning failure is error, and Retry/Re-plan (PLANNING_STARTED) plans again', () => {
    const actor = failedActor({ type: 'PLANNING_FAILED', error: 'no plan', recoverable: true });
    expect(actor.getSnapshot().value).toBe('error');
    expect(actor.getSnapshot().context.error).toBe('no plan');
    actor.send({ type: 'PLANNING_STARTED' });
    expect(actor.getSnapshot().value).toBe('planning');
    expect(actor.getSnapshot().context.error).toBeUndefined();
    expect(actor.getSnapshot().context.reviewReason).toBeUndefined();
  });

  it('a coding failure is error, and Retry with a plan (USER_RESUMED) resumes coding', () => {
    const actor = createActor(taskMachine).start();
    actor.send({ type: 'CODING_STARTED', subtaskId: '1-1', subtaskDescription: 'x' });
    actor.send({ type: 'CODING_FAILED', subtaskId: '1-1', error: 'validation failed', attemptCount: 1 });
    expect(actor.getSnapshot().value).toBe('error');
    actor.send({ type: 'USER_RESUMED' });
    expect(actor.getSnapshot().value).toBe('coding');
    expect(actor.getSnapshot().context.error).toBeUndefined();
  });

  it('a task restored in error (from disk) can resume coding or plan again', () => {
    for (const [event, target] of [
      [{ type: 'USER_RESUMED' } as const, 'coding'],
      [{ type: 'PLANNING_STARTED' } as const, 'planning'],
    ] as const) {
      const actor = createActor(taskMachine, {
        snapshot: taskMachine.resolveState({ value: 'error', context: { reviewReason: 'errors', error: 'x' } }),
      }).start();
      actor.send(event);
      expect(actor.getSnapshot().value).toBe(target);
    }
  });

  it('a real Human Review still goes to PR creation and done', () => {
    const actor = createActor(taskMachine, {
      snapshot: taskMachine.resolveState({ value: 'human_review', context: { reviewReason: 'completed' } }),
    }).start();
    actor.send({ type: 'CREATE_PR' });
    expect(actor.getSnapshot().value).toBe('creating_pr');
  });
});
