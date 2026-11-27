import { describe, expect, it } from 'vitest';
import type { DeliveryReceipt } from '../../../shared/types/delivery-receipt';
import { createProgressReporter } from '../progress';

function setup(opts: { json?: boolean; verbose?: boolean; redact?: string[] } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const r = createProgressReporter({ ...opts, out: (t) => void out.push(t), err: (t) => void err.push(t) });
  return { r, out, err };
}
const prog = (phase: string, currentSubtask?: string, message?: string) =>
  ({ phase, phaseProgress: 0, overallProgress: 0, currentSubtask, message }) as never;

describe('progress reporter', () => {
  it('prints phase/subtask changes only once', () => {
    const { r, out } = setup();
    r.progress(prog('planning', undefined, 'hello'));
    r.progress(prog('planning', undefined, 'again'));
    r.progress(prog('coding', 'subtask-1-2', 'title'));
    r.progress(prog('coding', 'subtask-1-2', 'title'));
    r.progress(prog('coding', 'subtask-1-3', 'next'));
    r.progress(prog('qa_review', undefined, 'qa'));
    expect(out).toEqual([
      '[planning] hello\n',
      '[coding] subtask-1-2: title\n',
      '[coding] subtask-1-3: next\n',
      '[qa_review] qa\n',
    ]);
  });
  it('gates agent logs on verbose and strips ANSI', () => {
    const quiet = setup();
    quiet.r.log('text');
    expect(quiet.out).toEqual([]);
    const loud = setup({ verbose: true });
    loud.r.log('\u001b[31mred\u001b[0m');
    expect(loud.out).toEqual(['red\n']);
  });
  it('json mode emits one object per line', () => {
    const { r, out } = setup({ json: true });
    r.log('hi');
    r.progress(prog('coding', 's1', 'm'));
    r.taskEvent({ type: 'QA_PASSED' });
    r.summary({ kind: 'success', exitCode: 0 }, { spec: '050', branch: 'b', worktree: '/w' });
    const objs = out.map((l) => JSON.parse(l));
    expect(objs.map((o) => o.type)).toEqual(['log', 'progress', 'task-event', 'result']);
    expect(objs[3]).toMatchObject({ kind: 'success', exitCode: 0, spec: '050', branch: 'b', worktree: '/w' });
    expect(out.every((l) => l.endsWith('\n') && l.trim().split('\n').length === 1)).toBe(true);
  });
  it('formats delivery receipts independently of the result', () => {
    const receipt: DeliveryReceipt = { id: 'r', createdAt: '2026-06-10T09:00:00.000Z',
      operation: 'issue_transition', event: 'review_ready', provider: 'jira', status: 'unknown', reason: 'unconfirmed' };
    const json = setup({ json: true });
    const text = setup();
    json.r.deliveryReceipts('001-demo', [receipt]);
    text.r.deliveryReceipts('001-demo', [receipt]);
    expect(json.out.map((line) => JSON.parse(line))).toEqual([{ type: 'delivery-receipts', spec: '001-demo', receipts: [receipt] }]);
    expect(text.out).toEqual([
      'DELIVERY spec=001-demo 2026-06-10T09:00:00.000Z issue_transition review_ready unknown provider=jira reason=unconfirmed\n',
    ]);
  });
  it('writes errors to stderr and summary line to stdout', () => {
    const { r, out, err } = setup();
    r.error('bad');
    r.summary({ kind: 'qa_failed', exitCode: 2, reason: 'why' }, { spec: 's', branch: 'b', worktree: 'w' });
    expect(err).toEqual(['error: bad\n', 'reason: why\n']);
    expect(out).toEqual(['RESULT qa_failed exit=2 spec=s branch=b worktree=w\n']);
  });
  it('redacts configured secrets everywhere', () => {
    for (const json of [false, true]) {
      const { r, out, err } = setup({ json, verbose: true, redact: ['sk-secret-123'] });
      r.log('key sk-secret-123 here');
      r.error('fail sk-secret-123');
      r.progress(prog('coding', 's', 'using sk-secret-123'));
      r.taskEvent({ type: 'CODING_FAILED', error: 'sk-secret-123' });
      r.summary({ kind: 'error', exitCode: 1, reason: 'sk-secret-123' });
      expect([...out, ...err].join('')).not.toContain('sk-secret-123');
    }
  });
});
