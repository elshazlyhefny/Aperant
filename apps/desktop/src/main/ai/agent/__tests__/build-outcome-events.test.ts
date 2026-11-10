/**
 * zeenha fork: the task event a finished build orchestration posts. A build
 * that failed before entering coding reports PLANNING_FAILED; the machine's
 * `planning` state ignores CODING_FAILED, which left such tasks stuck.
 */
import { createActor } from 'xstate';
import { describe, expect, it } from 'vitest';

import { taskMachine, type TaskEvent } from '../../../../shared/state-machines/task-machine';
import { budgetPauseMessage, budgetPauseTaskEvents, buildOutcomeTaskEvents } from '../build-outcome-events';

const base = { success: false, error: 'boom', codingCompleted: false, codingStarted: false, totalIterations: 2 };

describe('buildOutcomeTaskEvents', () => {
  it('reports success as QA_PASSED then BUILD_COMPLETE', () => {
    expect(buildOutcomeTaskEvents({ ...base, success: true, error: undefined }).map((e) => e.type)).toEqual(['QA_PASSED', 'BUILD_COMPLETE']);
  });

  it('reports a failure before coding started as PLANNING_FAILED with the error', () => {
    expect(buildOutcomeTaskEvents(base)).toEqual([{ type: 'PLANNING_FAILED', extra: { error: 'boom', recoverable: true } }]);
  });

  it('reports a failure during coding as CODING_FAILED with the error', () => {
    expect(buildOutcomeTaskEvents({ ...base, codingStarted: true })).toEqual([{ type: 'CODING_FAILED', extra: { error: 'boom' } }]);
  });

  it('reports a failure after coding completed as QA_MAX_ITERATIONS', () => {
    expect(buildOutcomeTaskEvents({ ...base, codingStarted: true, codingCompleted: true })).toEqual([
      { type: 'QA_MAX_ITERATIONS', extra: { iteration: 2, maxIterations: 3 } },
    ]);
  });

  it.each([
    ['planning', false],
    ['coding', true],
  ])('takes the machine from %s to error carrying the reason', (state, codingStarted) => {
    const actor = createActor(taskMachine, {
      snapshot: taskMachine.resolveState({ value: state, context: {} }),
    }).start();
    for (const event of buildOutcomeTaskEvents({ ...base, codingStarted })) {
      actor.send({ type: event.type, ...event.extra } as TaskEvent);
    }
    expect(actor.getSnapshot().value).toBe('error');
    expect(actor.getSnapshot().context.error).toBe('boom');
    actor.stop();
  });
});

describe('budgetPauseTaskEvents', () => {
  it('posts only TOKEN_BUDGET_REACHED with used and limit', () => {
    expect(budgetPauseTaskEvents({ used: 1234567, limit: 1000000 })).toEqual([
      { type: 'TOKEN_BUDGET_REACHED', extra: { used: 1234567, limit: 1000000 } },
    ]);
  });

  it('moves a coding task to human_review with reviewReason token_budget', () => {
    const actor = createActor(taskMachine, {
      snapshot: taskMachine.resolveState({ value: 'coding', context: {} }),
    });
    actor.start();
    for (const e of budgetPauseTaskEvents({ used: 5, limit: 4 })) actor.send({ type: e.type, ...e.extra } as TaskEvent);
    // PROCESS_EXITED after the pause is ignored
    actor.send({ type: 'PROCESS_EXITED', exitCode: 1, unexpected: true } as TaskEvent);
    expect(actor.getSnapshot().value).toBe('human_review');
    expect(actor.getSnapshot().context.reviewReason).toBe('token_budget');
  });

  it('formats the pause message with thousands separators', () => {
    expect(budgetPauseMessage({ used: 1234567, limit: 1000000 })).toBe('Token budget reached: 1,234,567 of 1,000,000 tokens used');
  });
});
