/**
 * zeenha fork: a single stalled stream used to fail a task during planning,
 * even though the same error is retried during coding.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionResult } from '../../session/types';
import { BuildOrchestrator, type SessionRunConfig } from '../build-orchestrator';

const session = (error: SessionResult['error']): SessionResult => ({
  outcome: 'error',
  stepsExecuted: 0,
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  messages: [],
  durationMs: 0,
  toolCallCount: 0,
  error,
});

const stalled = session({ code: 'stream_timeout', message: 'stream stalled', retryable: true });
const fatal = session({ code: 'x', message: 'planner stopped here', retryable: false });

let specDir: string;

beforeEach(async () => {
  specDir = await mkdtemp(join(tmpdir(), 'build-planning-retry-'));
  // Only timers: the orchestrator's real file I/O still needs setImmediate.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(specDir, { recursive: true, force: true });
});

function build(results: SessionResult[], abort?: AbortController) {
  const runSession = vi.fn(async (_config: SessionRunConfig) => {
    if (abort) abort.abort();
    return results.shift() ?? fatal;
  });
  const generatePrompt = vi.fn(async (..._args: unknown[]) => 'prompt');
  const orchestrator = new BuildOrchestrator({
    specDir,
    projectDir: specDir,
    generatePrompt,
    runSession,
    abortSignal: abort?.signal,
  });
  return { orchestrator, runSession, generatePrompt };
}

async function settle<T>(run: Promise<T>): Promise<T> {
  let done = false;
  const finished = run.finally(() => {
    done = true;
  });
  while (!done) {
    await vi.advanceTimersByTimeAsync(1_000);
    await new Promise((resolve) => setImmediate(resolve));
  }
  return finished;
}

describe('planner session errors', () => {
  it('restarts the planner after a stall without using a validation attempt', async () => {
    const { orchestrator, runSession, generatePrompt } = build([stalled, fatal]);

    const outcome = await settle(orchestrator.run());

    expect(runSession).toHaveBeenCalledTimes(2);
    expect(outcome.error).toBe('planner stopped here');
    expect(generatePrompt.mock.calls.map((call) => (call[2] as { attemptCount: number }).attemptCount)).toEqual([0, 0]);
  });

  it('gives up after the retry limit and reports the stall', async () => {
    const { orchestrator, runSession } = build([stalled, stalled, stalled, stalled]);

    const outcome = await settle(orchestrator.run());

    expect(runSession).toHaveBeenCalledTimes(3);
    expect(outcome.success).toBe(false);
    expect(outcome.error).toBe('stream stalled');
  });

  it('does not restart after an error that is not retryable', async () => {
    const { orchestrator, runSession } = build([fatal]);

    const outcome = await settle(orchestrator.run());

    expect(runSession).toHaveBeenCalledTimes(1);
    expect(outcome.error).toBe('planner stopped here');
  });

  it('does not restart a build cancelled during the stall', async () => {
    const { orchestrator, runSession } = build([stalled], new AbortController());

    const outcome = await settle(orchestrator.run());

    expect(runSession).toHaveBeenCalledTimes(1);
    expect(outcome.success).toBe(false);
    expect(outcome.error).toBe('Build cancelled');
  });
});
