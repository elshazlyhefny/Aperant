/**
 * zeenha fork: per-session cost records, in both spec directories, and a
 * recorder that can never break the build it measures.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SessionResult, StreamEvent } from '../../session/types';
import {
  aggregateRunMetrics,
  appendRunMetrics,
  buildSessionEntry,
  readRunMetrics,
  redactDetail,
  RUN_METRICS_FILE,
  SessionMetricsCollector,
} from '../run-metrics';
import type { SessionMetricsEntry } from '../run-metrics';

const call = (id: string, args: Record<string, unknown>): StreamEvent =>
  ({ type: 'tool-call', toolName: 'Bash', toolCallId: id, args }) as StreamEvent;
const done = (id: string, durationMs: number, isError = false, toolName = 'Bash'): StreamEvent =>
  ({ type: 'tool-result', toolName, toolCallId: id, result: '', durationMs, isError }) as StreamEvent;

const result: SessionResult = {
  outcome: 'completed',
  stepsExecuted: 4,
  usage: { promptTokens: 1000, completionTokens: 50, totalTokens: 1050, cacheReadTokens: 800, cacheCreationTokens: 100 },
  messages: [],
  durationMs: 9000,
  toolCallCount: 2,
};

describe('SessionMetricsCollector', () => {
  it('totals time per tool and counts errors', () => {
    const c = new SessionMetricsCollector();
    c.observe(call('a', { command: 'one' }));
    c.observe(done('a', 100));
    c.observe(call('b', { command: 'two' }));
    c.observe(done('b', 300, true));
    expect(c.summary().tools.Bash).toEqual({ calls: 2, errors: 1, totalMs: 400 });
    expect(c.summary().toolTimeMs).toBe(400);
  });

  it('keeps only the five slowest calls, slowest first, with what they ran', () => {
    const c = new SessionMetricsCollector();
    for (const [i, ms] of [10, 70, 20, 60, 30, 50].entries()) {
      c.observe(call(`t${i}`, { command: `cmd-${ms}` }));
      c.observe(done(`t${i}`, ms));
    }
    expect(c.summary().slowest.map((s) => s.ms)).toEqual([70, 60, 50, 30, 20]);
    expect(c.summary().slowest[0].detail).toBe('cmd-70');
  });

  it('never stores a credential from a command', () => {
    const c = new SessionMetricsCollector();
    c.observe(call('a', { command: 'curl -H "Authorization: Bearer abc123" -d GITHUB_TOKEN=xyz789 url' }));
    c.observe(done('a', 5));
    const detail = c.summary().slowest[0].detail ?? '';
    expect(detail).not.toContain('abc123');
    expect(detail).not.toContain('xyz789');
    expect(redactDetail('password: hunter2')).toBe('password: ***');
  });
});

describe('buildSessionEntry', () => {
  const base = { agentType: 'coder', phase: 'coding', model: 'claude-sonnet-5-5', startedAt: new Date('2026-11-08T10:00:00Z') };

  it('records tokens including the cache split', () => {
    const entry = buildSessionEntry({ ...base, result, collector: new SessionMetricsCollector() });
    expect(entry.tokens).toEqual({ input: 1000, output: 50, cacheRead: 800, cacheCreation: 100 });
    expect(entry.outcome).toBe('completed');
    expect(entry.durationMs).toBe(9000);
  });

  it('marks a session that threw, using elapsed time', () => {
    const entry = buildSessionEntry({
      ...base,
      result: null,
      collector: new SessionMetricsCollector(),
      now: new Date('2026-11-08T10:00:07Z'),
    });
    expect(entry.outcome).toBe('threw');
    expect(entry.durationMs).toBe(7000);
  });
});

describe('appendRunMetrics', () => {
  let worktreeSpec: string;
  let mainSpec: string;
  const entry = buildSessionEntry({
    agentType: 'coder', phase: 'coding', model: 'm', startedAt: new Date(), result, collector: new SessionMetricsCollector(),
  });
  const read = (dir: string) => JSON.parse(readFileSync(join(dir, RUN_METRICS_FILE), 'utf-8'));

  beforeEach(() => {
    worktreeSpec = mkdtempSync(join(tmpdir(), 'metrics-wt-'));
    mainSpec = mkdtempSync(join(tmpdir(), 'metrics-main-'));
  });
  afterEach(() => {
    rmSync(worktreeSpec, { recursive: true, force: true });
    rmSync(mainSpec, { recursive: true, force: true });
  });

  it('appends to both directories, so the record outlives the worktree', () => {
    appendRunMetrics([worktreeSpec, mainSpec], entry);
    appendRunMetrics([worktreeSpec, mainSpec], entry);
    expect(read(worktreeSpec).sessions).toHaveLength(2);
    expect(read(mainSpec).sessions).toHaveLength(2);
  });

  it('writes once when both directories are the same', () => {
    appendRunMetrics([mainSpec, mainSpec], entry);
    expect(read(mainSpec).sessions).toHaveLength(1);
  });

  it('survives a corrupt file and a missing directory without throwing', () => {
    writeFileSync(join(mainSpec, RUN_METRICS_FILE), '{not json');
    expect(() => appendRunMetrics([mainSpec, join(mainSpec, 'gone'), undefined], entry)).not.toThrow();
    expect(read(mainSpec).sessions).toHaveLength(1);
    expect(existsSync(join(mainSpec, 'gone'))).toBe(false);
  });
});

describe('readRunMetrics', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metrics-read-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns [] for a missing file', () => {
    expect(readRunMetrics(dir)).toEqual([]);
    expect(readRunMetrics(join(dir, 'gone'))).toEqual([]);
  });

  it('returns [] for corrupt JSON and for the wrong shape', () => {
    writeFileSync(join(dir, RUN_METRICS_FILE), '{not json');
    expect(readRunMetrics(dir)).toEqual([]);
    writeFileSync(join(dir, RUN_METRICS_FILE), JSON.stringify({ sessions: 'nope' }));
    expect(readRunMetrics(dir)).toEqual([]);
    writeFileSync(join(dir, RUN_METRICS_FILE), 'null');
    expect(readRunMetrics(dir)).toEqual([]);
  });

  it('drops non-object entries', () => {
    writeFileSync(join(dir, RUN_METRICS_FILE), JSON.stringify({ version: 1, sessions: [1, null, 'x', { phase: 'p' }] }));
    expect(readRunMetrics(dir)).toEqual([{ phase: 'p' }]);
  });

  it('returns entries written by appendRunMetrics', () => {
    const entry = buildSessionEntry({
      agentType: 'coder', phase: 'coding', model: 'm', startedAt: new Date(), result, collector: new SessionMetricsCollector(),
    });
    appendRunMetrics([dir], entry);
    expect(readRunMetrics(dir)).toEqual([entry]);
  });
});

describe('aggregateRunMetrics', () => {
  const make = (over: Partial<SessionMetricsEntry>): SessionMetricsEntry => ({
    agentType: 'coder', phase: 'coding', model: 'm', startedAt: '2026-11-08T10:00:00Z',
    durationMs: 1000, toolTimeMs: 400, outcome: 'completed', steps: 1, toolCalls: 1,
    tokens: { input: 100, output: 10, cacheRead: 50, cacheCreation: 5 },
    tools: {}, slowest: [], ...over,
  });

  it('gives a zeroed summary for empty input', () => {
    expect(aggregateRunMetrics([])).toEqual({
      sessionCount: 0, durationMs: 0, toolTimeMs: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      byPhase: [], byAgent: [], byTool: [], slowest: [],
    });
  });

  it('sums totals and groups by phase (first-seen order) and agent', () => {
    const s = aggregateRunMetrics([
      make({ phase: 'planning', agentType: 'planner' }),
      make({}),
      make({ durationMs: 2000, toolTimeMs: 100 }),
    ]);
    expect(s.sessionCount).toBe(3);
    expect(s.durationMs).toBe(4000);
    expect(s.toolTimeMs).toBe(900);
    expect(s.tokens).toEqual({ input: 300, output: 30, cacheRead: 150, cacheCreation: 15 });
    expect(s.byPhase.map((g) => [g.key, g.sessions, g.durationMs])).toEqual([['planning', 1, 1000], ['coding', 2, 3000]]);
    expect(s.byAgent.map((g) => [g.key, g.sessions])).toEqual([['planner', 1], ['coder', 2]]);
    expect(s.byPhase[1].tokens.input).toBe(200);
  });

  it('merges tools across sessions with error counts, slowest total first', () => {
    const s = aggregateRunMetrics([
      make({ tools: { Bash: { calls: 2, errors: 1, totalMs: 300 }, Read: { calls: 1, errors: 0, totalMs: 10 } } }),
      make({ tools: { Bash: { calls: 1, errors: 0, totalMs: 200 }, Grep: { calls: 1, errors: 1, totalMs: 900 } } }),
    ]);
    expect(s.byTool).toEqual([
      { tool: 'Grep', calls: 1, errors: 1, totalMs: 900 },
      { tool: 'Bash', calls: 3, errors: 1, totalMs: 500 },
      { tool: 'Read', calls: 1, errors: 0, totalMs: 10 },
    ]);
  });

  it('keeps the five slowest calls overall, tagged with agent and phase', () => {
    const s = aggregateRunMetrics([
      make({ slowest: [{ tool: 'Bash', ms: 70 }, { tool: 'Bash', ms: 20 }, { tool: 'Bash', ms: 10 }] }),
      make({ phase: 'qa', agentType: 'qa_reviewer', slowest: [{ tool: 'Read', ms: 90, detail: 'f' }, { tool: 'Bash', ms: 60 }, { tool: 'Bash', ms: 30 }] }),
    ]);
    expect(s.slowest.map((c) => c.ms)).toEqual([90, 70, 60, 30, 20]);
    expect(s.slowest[0]).toEqual({ tool: 'Read', ms: 90, detail: 'f', agentType: 'qa_reviewer', phase: 'qa' });
  });

  it('does not throw on entries with missing fields', () => {
    const broken = [{ phase: 'p' }, {}, { tokens: {}, tools: null, slowest: 'x' }] as unknown as SessionMetricsEntry[];
    const s = aggregateRunMetrics(broken);
    expect(s.sessionCount).toBe(3);
    expect(s.durationMs).toBe(0);
    expect(s.tokens.input).toBe(0);
    expect(s.byTool).toEqual([]);
  });
});
