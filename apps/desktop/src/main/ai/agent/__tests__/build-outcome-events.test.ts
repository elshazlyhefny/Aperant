/**
 * zeenha fork: the task event a finished build orchestration posts. A build
 * that failed before entering coding reports PLANNING_FAILED; the machine's
 * `planning` state ignores CODING_FAILED, which left such tasks stuck.
 */
import { createActor } from 'xstate';
import { describe, expect, it } from 'vitest';

import { taskMachine, type TaskEvent } from '../../../../shared/state-machines/task-machine';
import { buildOutcomeTaskEvents } from '../build-outcome-events';

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
