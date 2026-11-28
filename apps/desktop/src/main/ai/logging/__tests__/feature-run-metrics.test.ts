/**
 * zeenha fork: Roadmap and Ideation usage metering.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  StreamUsageMeter,
  buildFeatureSessionEntry,
  modelLabel,
  normalizeUsage,
  recordFeatureSession,
} from '../feature-run-metrics';
import { RUN_METRICS_FILE, readRunMetrics } from '../run-metrics';

describe('normalizeUsage', () => {
  it('reads the AI SDK v6 shape, with the cache split in inputTokenDetails', () => {
    expect(
      normalizeUsage({ inputTokens: 100, outputTokens: 9, inputTokenDetails: { cacheReadTokens: 60, cacheWriteTokens: 5 } }),
    ).toEqual({ input: 100, output: 9, cacheRead: 60, cacheCreation: 5 });
  });

  it('reads the Claude Code engine shape', () => {
    expect(normalizeUsage({ inputTokens: 100, outputTokens: 9, cacheReadTokens: 70, cacheCreationTokens: 3 })).toEqual({
      input: 100,
      output: 9,
      cacheRead: 70,
      cacheCreation: 3,
    });
  });

  it('gives zeros for a missing or malformed usage', () => {
    expect(normalizeUsage(undefined)).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
    expect(normalizeUsage({ inputTokens: 'lots', outputTokens: Number.NaN })).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
    });
  });
});

describe('StreamUsageMeter', () => {
  it('prefers the stream total and counts steps and tool calls', () => {
    const meter = new StreamUsageMeter();
    meter.observe({ type: 'tool-call', toolName: 'Read' });
    meter.observe({ type: 'finish-step', usage: { inputTokens: 10, outputTokens: 1 } });
    meter.observe({ type: 'tool-call', toolName: 'Grep' });
    meter.observe({ type: 'finish-step', usage: { inputTokens: 20, outputTokens: 2 } });
    meter.observe({ type: 'finish', totalUsage: { inputTokens: 31, outputTokens: 3 } });
    expect(meter.tokens()).toEqual({ input: 31, output: 3, cacheRead: 0, cacheCreation: 0 });
    expect(meter.steps).toBe(2);
    expect(meter.toolCalls).toBe(2);
  });

  it('falls back to the per-step tally when the stream ends without a total', () => {
    const meter = new StreamUsageMeter();
    meter.observe({ type: 'finish-step', usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 4 } });
    meter.observe({ type: 'finish-step', usage: { inputTokens: 20, outputTokens: 2, cacheReadTokens: 6 } });
    expect(meter.tokens()).toEqual({ input: 30, output: 3, cacheRead: 10, cacheCreation: 0 });
  });

  it('ignores an empty stream total', () => {
    const meter = new StreamUsageMeter();
    meter.observe({ type: 'finish-step', usage: { inputTokens: 10, outputTokens: 1 } });
    meter.observe({ type: 'finish', totalUsage: { inputTokens: 0, outputTokens: 0 } });
    expect(meter.tokens().input).toBe(10);
  });
});

describe('modelLabel', () => {
  it('uses the resolved id, then the model object, then a fallback', () => {
    expect(modelLabel({ resolvedModelId: 'gpt-6.2-astra', model: { modelId: 'x' } })).toBe('gpt-6.2-astra');
    expect(modelLabel({ model: { modelId: 'claude-sonnet' } })).toBe('claude-sonnet');
    expect(modelLabel({ model: 'opus' })).toBe('opus');
    expect(modelLabel({})).toBe('unknown');
  });
});

describe('recordFeatureSession', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'feature-metrics-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const meterWith = (input: number, output: number) => {
    const meter = new StreamUsageMeter();
    meter.observe({ type: 'tool-call', toolName: 'Read' });
    meter.observe({ type: 'finish-step', usage: { inputTokens: input, outputTokens: output } });
    return meter;
  };

  it('appends one entry per session in the task metrics format', () => {
    const startedAt = new Date('2026-11-28T14:41:00Z');
    recordFeatureSession({
      directory: dir,
      agentType: 'roadmap_discovery',
      phase: 'roadmap_discovery',
      model: 'gpt-6.2-astra',
      thinkingLevel: 'high',
      startedAt,
      meter: meterWith(1200, 80),
      outcome: 'completed',
      now: new Date('2026-11-28T14:43:00Z'),
    });
    recordFeatureSession({
      directory: dir,
      agentType: 'roadmap_features',
      phase: 'roadmap_features',
      model: 'gpt-6.2-astra',
      startedAt,
      meter: meterWith(5000, 900),
      outcome: 'completed',
    });

    const sessions = readRunMetrics(dir);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      agentType: 'roadmap_discovery',
      phase: 'roadmap_discovery',
      model: 'gpt-6.2-astra',
      thinkingLevel: 'high',
      startedAt: '2026-11-28T14:41:00.000Z',
      durationMs: 120_000,
      outcome: 'completed',
      steps: 1,
      toolCalls: 1,
      tokens: { input: 1200, output: 80, cacheRead: 0, cacheCreation: 0 },
    });
    expect(sessions[0].error).toBeUndefined();
    expect(sessions[1].tokens.input).toBe(5000);
  });

  it('records a failure with its message redacted', () => {
    recordFeatureSession({
      directory: dir,
      agentType: 'ideation',
      phase: 'security_hardening',
      model: 'm',
      startedAt: new Date(),
      meter: meterWith(10, 1),
      outcome: 'threw',
      error: new Error('Incorrect API key provided: sk-proj-abcdefghijkl'),
    });
    const [session] = readRunMetrics(dir);
    expect(session.outcome).toBe('threw');
    expect(session.error?.code).toBe('threw');
    expect(session.error?.message).not.toContain('abcdefghijkl');
    expect(session.tokens.input).toBe(10);
  });

  it('labels an error the stream reported as stream_error', () => {
    const entry = buildFeatureSessionEntry({
      directory: dir,
      agentType: 'ideation',
      phase: 'code_quality',
      model: 'm',
      startedAt: new Date(),
      meter: new StreamUsageMeter(),
      outcome: 'error',
      error: 'Write: Permission denied',
    });
    expect(entry.error).toEqual({ code: 'stream_error', message: 'Write: Permission denied' });
  });

  it('does nothing, and does not throw, when the directory does not exist', () => {
    const missing = join(dir, 'missing');
    expect(() =>
      recordFeatureSession({
        directory: missing,
        agentType: 'ideation',
        phase: 'code_quality',
        model: 'm',
        startedAt: new Date(),
        meter: new StreamUsageMeter(),
        outcome: 'completed',
      }),
    ).not.toThrow();
    expect(existsSync(join(missing, RUN_METRICS_FILE))).toBe(false);
  });

  it('keeps earlier sessions when it appends', () => {
    for (let i = 0; i < 3; i++) {
      recordFeatureSession({
        directory: dir,
        agentType: 'ideation',
        phase: 'code_quality',
        model: 'm',
        startedAt: new Date(),
        meter: meterWith(i + 1, 1),
        outcome: 'completed',
      });
    }
    const file = JSON.parse(readFileSync(join(dir, RUN_METRICS_FILE), 'utf-8'));
    expect(file.version).toBe(1);
    expect(file.sessions.map((s: { tokens: { input: number } }) => s.tokens.input)).toEqual([1, 2, 3]);
  });
});
