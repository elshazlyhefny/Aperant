/**
 * zeenha fork: project-wide aggregation over real spec directories, including
 * missing, truncated and malformed metrics files.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SessionMetricsEntry } from '../../../../shared/types/run-metrics';
import {
  buildProjectRunMetrics,
  loadProjectRunMetricInputs,
  readRunMetricsState,
  type ProjectTaskRef,
} from '../project-run-metrics';
import { RUN_METRICS_FILE } from '../run-metrics';

const NOW = new Date('2026-06-30T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

const session = (over: Partial<SessionMetricsEntry> = {}): SessionMetricsEntry => ({
  agentType: 'coder',
  phase: 'coding',
  model: 'opus',
  startedAt: daysAgo(1),
  durationMs: 1000,
  toolTimeMs: 0,
  outcome: 'completed',
  steps: 1,
  toolCalls: 0,
  tokens: { input: 100, output: 10, cacheRead: 80, cacheCreation: 0 },
  tools: {},
  slowest: [],
  ...over,
});

let root: string;

function writeMetrics(specId: string, content: unknown, raw = false): void {
  const dir = join(root, specId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, RUN_METRICS_FILE),
    raw ? (content as string) : JSON.stringify({ version: 1, sessions: content })
  );
}

const task = (specId: string, status: string, updatedAt = daysAgo(1)): ProjectTaskRef => ({
  specId,
  status,
  title: specId,
  updatedAt,
});

async function build(tasks: ProjectTaskRef[], periodDays: number | null = 30) {
  const inputs = await loadProjectRunMetricInputs(tasks, root);
  return buildProjectRunMetrics(inputs, { periodDays, now: NOW });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'project-run-metrics-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('readRunMetricsState', () => {
  it('distinguishes ok, missing and corrupt', async () => {
    writeMetrics('ok', [session()]);
    writeMetrics('empty', []);
    writeMetrics('trunc', '{"sessions": [', true);
    writeMetrics('null', 'null', true);
    writeMetrics('str', '{"sessions":"x"}', true);
    expect((await readRunMetricsState(join(root, 'ok'))).state).toBe('ok');
    expect((await readRunMetricsState(join(root, 'nothing'))).state).toBe('missing');
    expect((await readRunMetricsState(join(root, 'empty'))).state).toBe('missing');
    expect((await readRunMetricsState(join(root, 'trunc'))).state).toBe('corrupt');
    expect((await readRunMetricsState(join(root, 'null'))).state).toBe('corrupt');
    expect((await readRunMetricsState(join(root, 'str'))).state).toBe('corrupt');
  });

  it('filters non-object entries', async () => {
    writeMetrics('g', [session(), null, 5, 'x', [1]]);
    const state = await readRunMetricsState(join(root, 'g'));
    expect(state.state === 'ok' && state.sessions).toHaveLength(1);
  });
});

describe('buildProjectRunMetrics', () => {
  it('totals and averages per completed task', async () => {
    writeMetrics('a', [session(), session({ durationMs: 3000 })]);
    writeMetrics('b', [session({ tokens: { input: 300, output: 30, cacheRead: 0, cacheCreation: 0 } })]);
    writeMetrics('c', [session()]);
    const m = await build([task('a', 'done'), task('b', 'pr_created'), task('c', 'in_progress')]);
    expect(m.taskCount).toBe(3);
    expect(m.included).toBe(3);
    expect(m.completedTasks).toBe(2);
    expect(m.totals.sessions).toBe(4);
    expect(m.totals.tokens.input).toBe(600);
    expect(m.totals.tokens.cacheRead).toBe(240);
    expect(m.totals.totalTokens).toBe(660);
    expect(m.perCompletedTask?.totalTokens).toBe((220 + 330) / 2);
    expect(m.perCompletedTask?.durationMs).toBe((4000 + 1000) / 2);
  });

  it('applies the period cutoff, and all time keeps everything', async () => {
    writeMetrics('new', [session({ startedAt: daysAgo(2) })]);
    writeMetrics('old', [session({ startedAt: daysAgo(100) })]);
    const tasks = [task('new', 'done'), task('old', 'done', daysAgo(100))];
    expect((await build(tasks, 7)).taskCount).toBe(1);
    expect((await build(tasks, 30)).completedTasks).toBe(1);
    expect((await build(tasks, null)).completedTasks).toBe(2);
  });

  it('groups by phase and model with unknown fallback', async () => {
    writeMetrics('a', [
      session({ phase: 'planning', model: 'sonnet' }),
      session({ phase: 'coding', model: 'opus' }),
      session({ phase: 'coding', model: 'opus' }),
      { startedAt: daysAgo(1) } as unknown as SessionMetricsEntry,
    ]);
    const m = await build([task('a', 'done')]);
    const coding = m.byPhase.find((g) => g.key === 'coding');
    expect(coding?.sessions).toBe(2);
    expect(coding?.tasks).toBe(1);
    expect(coding?.totalTokens).toBe(220);
    expect(m.byPhase.map((g) => g.key)).toContain('unknown');
    expect(m.byModel.map((g) => g.key).sort()).toEqual(['opus', 'sonnet', 'unknown']);
  });

  it('counts QA iterations only for tasks with qa_reviewer sessions', async () => {
    writeMetrics('a', [session(), session({ agentType: 'qa_reviewer', phase: 'qa' }), session({ agentType: 'qa_reviewer', phase: 'qa' })]);
    writeMetrics('b', [session({ agentType: 'qa_reviewer', phase: 'qa' })]);
    writeMetrics('c', [session()]);
    const m = await build([task('a', 'done'), task('b', 'done'), task('c', 'done')]);
    expect(m.qa).toEqual({ tasksWithQa: 2, totalIterations: 3, averageIterations: 1.5 });
  });

  it('counts failed-before-work tasks with or without metrics, not as excluded', async () => {
    writeMetrics('f1', [session()]);
    const m = await build([task('f1', 'error'), task('f2', 'error'), task('q', 'queue'), task('b', 'backlog')]);
    expect(m.failedBeforeWork.count).toBe(2);
    expect(m.failedBeforeWork.tasks?.map((t) => t.specId)).toEqual(['f1', 'f2']);
    expect(m.excluded).toEqual({ missing: 0, corrupt: 0 });
    expect(m.included).toBe(1);
    expect(m.taskCount).toBe(2);
  });

  it('excludes and counts missing and corrupt files without throwing', async () => {
    writeMetrics('ok', [session()]);
    writeMetrics('trunc', '{"sessions": [', true);
    writeMetrics('null', 'null', true);
    writeMetrics('str', '{"sessions":"x"}', true);
    const m = await build([
      task('ok', 'done'),
      task('trunc', 'done'),
      task('null', 'in_progress'),
      task('str', 'done'),
      task('gone', 'done'),
    ]);
    expect(m.included).toBe(1);
    expect(m.excluded).toEqual({ missing: 1, corrupt: 3 });
    expect(m.totals.sessions).toBe(1);
  });

  it('tolerates garbage session fields', async () => {
    writeMetrics('a', [
      { agentType: 7, phase: null, model: {}, durationMs: 'x', tokens: { input: 'a', output: NaN }, startedAt: 12 },
      session(),
    ]);
    const m = await build([task('a', 'done')]);
    expect(m.totals.sessions).toBe(2);
    expect(m.totals.totalTokens).toBe(110);
  });

  it('reports null averages with no completed tasks', async () => {
    writeMetrics('a', [session()]);
    const m = await build([task('a', 'in_progress')]);
    expect(m.perCompletedTask).toBeNull();
    expect(m.qa.averageIterations).toBeNull();
    expect(m.trend).toEqual([]);
    expect(m.failedBeforeWork).toEqual({ count: 0 });
  });

  it('buckets the trend by UTC day of the newest session, ascending', async () => {
    writeMetrics('a', [session({ startedAt: '2026-06-25T23:59:00.000Z' })]);
    writeMetrics('b', [session({ startedAt: '2026-06-20T01:00:00.000Z' }), session({ startedAt: '2026-06-26T00:30:00.000Z' })]);
    writeMetrics('c', [session({ startedAt: '2026-06-25T10:00:00.000Z' })]);
    const m = await build([task('a', 'done'), task('b', 'done'), task('c', 'done')]);
    expect(m.trend.map((p) => p.date)).toEqual(['2026-06-25', '2026-06-26']);
    expect(m.trend[0]).toMatchObject({ completedTasks: 2, totalTokens: 220, tokensPerCompletedTask: 110 });
    expect(m.trend[1]).toMatchObject({ completedTasks: 1, totalTokens: 220 });
  });
});

describe('loadProjectRunMetricInputs', () => {
  it('keeps the event loop serviced for 300 tasks', async () => {
    const tasks: ProjectTaskRef[] = [];
    for (let i = 0; i < 300; i++) {
      const id = `t${i}`;
      writeMetrics(id, [session()]);
      tasks.push(task(id, 'done'));
    }
    let ticks = 0;
    const interval = setInterval(() => {
      ticks += 1;
    }, 0);
    const immediate = new Promise<void>((resolve) => setImmediate(resolve));
    const inputs = await loadProjectRunMetricInputs(tasks, root);
    await immediate;
    clearInterval(interval);
    expect(inputs).toHaveLength(300);
    expect(inputs.every((i) => i.metrics.state === 'ok')).toBe(true);
    expect(ticks).toBeGreaterThan(0);
    expect(buildProjectRunMetrics(inputs, { periodDays: 30, now: NOW }).completedTasks).toBe(300);
  });
});
