import { describe, expect, it } from 'vitest';
import { classifyRun, EXIT_ERROR, EXIT_QA_FAILED, EXIT_SUCCESS } from '../outcome';

describe('classifyRun', () => {
  it('constants', () => {
    expect([EXIT_SUCCESS, EXIT_ERROR, EXIT_QA_FAILED]).toEqual([0, 1, 2]);
  });
  it('QA_PASSED with or without BUILD_COMPLETE is success', () => {
    expect(classifyRun({ events: [{ type: 'QA_PASSED' }], exit: { code: 0 } })).toEqual({ kind: 'success', exitCode: 0 });
    expect(classifyRun({ events: [{ type: 'QA_PASSED' }, { type: 'BUILD_COMPLETE' }] }).kind).toBe('success');
  });
  it('QA_MAX_ITERATIONS is qa_failed/2', () => {
    const r = classifyRun({ events: [{ type: 'QA_MAX_ITERATIONS', extra: { iteration: 3, reason: 'tests red' } }] });
    expect(r).toEqual({ kind: 'qa_failed', exitCode: 2, reason: 'tests red' });
    expect(classifyRun({ events: [{ type: 'QA_MAX_ITERATIONS', extra: { iteration: 3 } }] }).reason).toContain('3');
  });
  it('PLANNING_FAILED / CODING_FAILED carry the error', () => {
    expect(classifyRun({ events: [{ type: 'PLANNING_FAILED', extra: { error: 'bad plan' } }] })).toEqual({ kind: 'error', exitCode: 1, reason: 'bad plan' });
    expect(classifyRun({ events: [{ type: 'CODING_FAILED', error: 'boom' }] }).reason).toBe('boom');
  });
  it('worker error event is error', () => {
    expect(classifyRun({ events: [], errors: ['x', 'oops'], exit: { code: 0 } })).toEqual({ kind: 'error', exitCode: 1, reason: 'oops' });
  });
  it('non-zero exit without terminal event is error', () => {
    expect(classifyRun({ events: [], exit: { code: 3 } }).reason).toContain('code 3');
  });
  it('exit 0 without terminal event is never success', () => {
    const r = classifyRun({ events: [{ type: 'BUILD_COMPLETE' }], exit: { code: 0 } });
    expect(r).toEqual({ kind: 'error', exitCode: 1, reason: 'worker ended without reporting a build result' });
  });
  it('abort by signal is error even after QA_PASSED', () => {
    expect(classifyRun({ events: [], abortSignal: 'SIGINT' })).toMatchObject({ kind: 'error', exitCode: 1 });
    expect(classifyRun({ events: [{ type: 'QA_PASSED' }], abortSignal: 'SIGTERM' }).kind).toBe('error');
    expect(classifyRun({ events: [], exit: { code: null, signal: 'SIGKILL' } }).kind).toBe('error');
  });
});
