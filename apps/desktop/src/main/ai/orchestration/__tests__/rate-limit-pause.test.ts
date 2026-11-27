/**
 * zeenha fork: a rate limit during planning used to fail the task, and spec
 * phases retried at once into the same limit. Both now pause and wait like the
 * coder, then run the session again without using up an attempt.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../pause-handler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pause-handler')>();
  return { ...actual, pauseForRateLimit: vi.fn(async () => false) };
});

import type { SessionResult } from '../../session/types';
import { BuildOrchestrator, type SessionRunConfig } from '../build-orchestrator';
import { SpecOrchestrator } from '../spec-orchestrator';
import * as pauseHandler from '../pause-handler';

const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
const rateLimited: SessionResult = {
  outcome: 'rate_limited', stepsExecuted: 0, usage, messages: [], durationMs: 0, toolCallCount: 0,
  error: { code: 'rate_limited', message: 'Rate limit exceeded: limit reached, resets 3am', retryable: true },
};
const fatal: SessionResult = {
  outcome: 'error', stepsExecuted: 0, usage, messages: [], durationMs: 0, toolCallCount: 0,
  error: { code: 'x', message: 'planner stopped here', retryable: false },
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rate-limit-pause-'));
  vi.mocked(pauseHandler.pauseForRateLimit).mockClear();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('planning rate limit', () => {
  it('waits for the reset and plans again instead of failing the task', async () => {
    const results = [rateLimited, fatal];
    const runSession = vi.fn(async (_config: SessionRunConfig) => results.shift() ?? fatal);
    const generatePrompt = vi.fn(async (..._args: unknown[]) => 'prompt');
    const orchestrator = new BuildOrchestrator({ specDir: dir, projectDir: dir, generatePrompt, runSession });

    const outcome = await orchestrator.run();

    expect(pauseHandler.pauseForRateLimit).toHaveBeenCalledTimes(1);
    expect(pauseHandler.pauseForRateLimit).toHaveBeenCalledWith(dir, rateLimited.error?.message, expect.any(Object));
    expect(runSession).toHaveBeenCalledTimes(2);
    // The task ends on the later error, not on the rate limit
    expect(outcome.error).toBe('planner stopped here');
    // The wait did not use up a validation attempt
    expect(generatePrompt.mock.calls.map((call) => (call[2] as { attemptCount: number }).attemptCount)).toEqual([0, 0]);
  });
});

describe('spec phase rate limit', () => {
  it('waits for the reset and reruns the phase without using a retry', async () => {
    const phases: string[] = [];
    let limited = true;
    const orchestrator = new SpecOrchestrator({
      specDir: dir,
      projectDir: dir,
      taskDescription: 'Fix typo',
      complexityOverride: 'simple',
      generatePrompt: async () => 'prompt',
      runSession: async (config): Promise<SessionResult> => {
        phases.push(config.specPhase);
        if (config.specPhase === 'quick_spec' && limited) {
          limited = false;
          return rateLimited;
        }
        if (config.specPhase === 'quick_spec') {
          await writeFile(join(dir, 'spec.md'), '# Quick Spec');
          await writeFile(join(dir, 'implementation_plan.json'), JSON.stringify({
            feature: 'Demo',
            phases: [{ id: 'p1', name: 'Implement', subtasks: [{ id: 's1', description: 'Fix typo', status: 'pending' }] }],
          }));
        }
        return { outcome: 'completed', stepsExecuted: 1, durationMs: 1, toolCallCount: 1, messages: [], usage } as SessionResult;
      },
    });

    const outcome = await orchestrator.run();

    expect(outcome.success).toBe(true);
    expect(pauseHandler.pauseForRateLimit).toHaveBeenCalledTimes(1);
    expect(phases).toEqual(['quick_spec', 'quick_spec', 'validation']);
  });
});

describe('pauseForRateLimit', () => {
  it('writes the reset time named in the error into the pause file', async () => {
    const actual = await vi.importActual<typeof import('../pause-handler')>('../pause-handler');
    const controller = new AbortController();
    const resetSeconds = Math.floor(Date.now() / 1000) + 600;
    const waiting = actual.pauseForRateLimit(dir, `usage limit reached|${resetSeconds}`, { signal: controller.signal });
    const data = JSON.parse(await readFile(join(dir, actual.RATE_LIMIT_PAUSE_FILE), 'utf8'));
    expect(data.resetTimestamp).toBe(new Date(resetSeconds * 1000).toISOString());
    // Stop the wait; the pause file is cleaned up afterwards
    controller.abort();
    expect(await waiting).toBe(false);
  });
});
