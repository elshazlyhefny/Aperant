import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { SessionConfig } from '../types';

const mockStreamText = vi.fn();
vi.mock('ai', () => ({
  streamText: (...args: unknown[]) => mockStreamText(...args),
  stepCountIs: (n: number) => ({ type: 'stepCount', count: n }),
}));

import { runAgentSession } from '../runner';
import { TokenBudgetGuard } from '../token-budget';

function config(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    agentType: 'coder',
    model: {} as SessionConfig['model'],
    systemPrompt: 's',
    initialMessages: [{ role: 'user', content: 'Hello' }],
    toolContext: {} as SessionConfig['toolContext'],
    maxSteps: 10,
    specDir: '/specs/001',
    projectDir: '/project',
    ...overrides,
  };
}

function streamResult(usage = { inputTokens: 100, outputTokens: 50 }) {
  return {
    fullStream: (async function* () {
      yield { type: 'finish-step', usage };
    })(),
    text: Promise.resolve(''),
    totalUsage: Promise.resolve(usage),
  };
}

const step = (i: number, o: number) => ({ usage: { inputTokens: i, outputTokens: o } });

/** Evaluate the budget condition (second entry of the stopWhen array) over steps. */
function budgetStops(steps: Array<ReturnType<typeof step>>): boolean {
  const stopWhen = mockStreamText.mock.calls.at(-1)?.[0].stopWhen as Array<(a: { steps: unknown[] }) => boolean>;
  return stopWhen[1]({ steps });
}

describe('TokenBudgetGuard', () => {
  it('counts baseline, committed and current segments', () => {
    const guard = new TokenBudgetGuard({ limit: 1000, readSpentTokens: () => 300 });
    expect(guard.used(100)).toBe(400);
    guard.commitSegment({ promptTokens: 200, completionTokens: 100 });
    expect(guard.used(0)).toBe(600);
    expect(guard.isExceeded(399)).toBe(false);
    expect(guard.isExceeded(400)).toBe(true);
    expect(guard.snapshot()).toEqual({ limit: 1000, used: 600 });
  });

  it('beginSession re-reads the baseline and resets committed segments', () => {
    let spent = 10;
    const guard = new TokenBudgetGuard({ limit: 100, readSpentTokens: () => spent });
    guard.commitSegment({ promptTokens: 20, completionTokens: 0 });
    spent = 50;
    guard.beginSession();
    expect(guard.used()).toBe(50);
  });

  it('never exceeds without a limit', () => {
    const guard = new TokenBudgetGuard({ readSpentTokens: () => 1e9 });
    expect(guard.enabled).toBe(false);
    expect(guard.isExceeded(1e9)).toBe(false);
  });

  it('counts committed cache reads at a tenth', () => {
    const guard = new TokenBudgetGuard({ limit: 10_000, readSpentTokens: () => 0 });
    guard.commitSegment({ promptTokens: 1000, completionTokens: 100, cacheReadTokens: 900 });
    expect(guard.used()).toBe(100 + 100 + 90);
  });

  it('weights cache reads in the stop condition', () => {
    const guard = new TokenBudgetGuard({ limit: 300, readSpentTokens: () => 0 });
    const stop = guard.buildStopCondition();
    const cached = { usage: { inputTokens: 1000, outputTokens: 0, inputTokenDetails: { cacheReadTokens: 1000 } } };
    // 1000 cache reads count as 100, under the limit of 300.
    expect(stop({ steps: [cached] } as never)).toBe(false);
    expect(stop({ steps: [cached, cached, cached] } as never)).toBe(true);
  });
});

describe('TokenBudgetGuard early warning', () => {
  it('warns once when usage first reaches 80%', () => {
    const onWarning = vi.fn();
    const guard = new TokenBudgetGuard({ limit: 1000, readSpentTokens: () => 0, onWarning });
    guard.commitSegment({ promptTokens: 700, completionTokens: 0 });
    expect(onWarning).not.toHaveBeenCalled();
    guard.commitSegment({ promptTokens: 100, completionTokens: 0 });
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith({ limit: 1000, used: 800 });
    guard.commitSegment({ promptTokens: 100, completionTokens: 0 });
    guard.beginSession();
    guard.checkWarning(50);
    expect(onWarning).toHaveBeenCalledTimes(1);
  });

  it('warns from the stop condition mid-session', () => {
    const onWarning = vi.fn();
    const guard = new TokenBudgetGuard({ limit: 1000, readSpentTokens: () => 500, onWarning });
    const stop = guard.buildStopCondition();
    expect(stop({ steps: [step(200, 0)] } as never)).toBe(false);
    expect(onWarning).not.toHaveBeenCalled();
    expect(stop({ steps: [step(200, 0), step(150, 0)] } as never)).toBe(false);
    expect(onWarning).toHaveBeenCalledWith({ limit: 1000, used: 850 });
  });

  it('leaves a jump past the limit to the budget stop', () => {
    const onWarning = vi.fn();
    const guard = new TokenBudgetGuard({ limit: 1000, readSpentTokens: () => 0, onWarning });
    guard.commitSegment({ promptTokens: 1200, completionTokens: 0 });
    expect(onWarning).not.toHaveBeenCalled();
  });

  it('never warns without a limit', () => {
    const onWarning = vi.fn();
    const guard = new TokenBudgetGuard({ readSpentTokens: () => 1e9, onWarning });
    guard.checkWarning(1e9);
    expect(onWarning).not.toHaveBeenCalled();
  });
});

describe('runAgentSession token budget', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does nothing below the limit', async () => {
    mockStreamText.mockReturnValue(streamResult());
    const guard = new TokenBudgetGuard({ limit: 10_000, readSpentTokens: () => 0 });
    const result = await runAgentSession(config({ tokenBudget: guard }));
    expect(result.outcome).toBe('completed');
    expect(result.error).toBeUndefined();
    expect(guard.used()).toBe(150);
  });

  it('stops after the step that crosses the limit and returns cancelled/token_budget', async () => {
    const guard = new TokenBudgetGuard({ limit: 200, readSpentTokens: () => 0 });
    mockStreamText.mockImplementation((opts: { stopWhen: Array<(a: { steps: unknown[] }) => boolean> }) => {
      const stop = opts.stopWhen[1];
      return {
        fullStream: (async function* () {
          yield { type: 'finish-step', usage: { inputTokens: 100, outputTokens: 50 } };
          expect(stop({ steps: [step(100, 50)] })).toBe(false);
          yield { type: 'finish-step', usage: { inputTokens: 100, outputTokens: 50 } };
          expect(stop({ steps: [step(100, 50), step(100, 50)] })).toBe(true);
        })(),
        text: Promise.resolve(''),
        totalUsage: Promise.resolve({ inputTokens: 200, outputTokens: 100 }),
      };
    });
    const result = await runAgentSession(config({ tokenBudget: guard }));
    expect(result.outcome).toBe('cancelled');
    expect(result.error).toMatchObject({ code: 'token_budget', retryable: false });
  });

  it('counts a baseline from earlier sessions', async () => {
    mockStreamText.mockReturnValue(streamResult());
    const guard = new TokenBudgetGuard({ limit: 1000, readSpentTokens: () => 900 });
    const result = await runAgentSession(config({ tokenBudget: guard }));
    expect(budgetStops([step(10, 10)])).toBe(true);
    expect(result.outcome).toBe('cancelled');
    expect(result.error?.code).toBe('token_budget');
  });

  it('accumulates continuation segments', async () => {
    const guard = new TokenBudgetGuard({ limit: 400, readSpentTokens: () => 0 });
    mockStreamText.mockReturnValueOnce(streamResult({ inputTokens: 100, outputTokens: 50 }));
    expect((await runAgentSession(config({ tokenBudget: guard }))).outcome).toBe('completed');
    mockStreamText.mockReturnValueOnce(streamResult({ inputTokens: 100, outputTokens: 50 }));
    const second = await runAgentSession(config({ tokenBudget: guard }));
    expect(guard.used()).toBe(300);
    expect(second.outcome).toBe('completed');
    mockStreamText.mockReturnValueOnce(streamResult({ inputTokens: 100, outputTokens: 50 }));
    const third = await runAgentSession(config({ tokenBudget: guard }));
    expect(third.outcome).toBe('cancelled');
  });

  it('keeps the usage of a stream that failed partway, counted once', async () => {
    const guard = new TokenBudgetGuard({ limit: 10_000, readSpentTokens: () => 0 });
    mockStreamText.mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'tool-call', toolName: 'Read', toolCallId: 't1', input: {} };
        yield { type: 'finish-step', usage: { inputTokens: 300, outputTokens: 40, inputTokenDetails: { cacheReadTokens: 200 } } };
        throw new Error('Network error');
      })(),
      text: Promise.resolve(''),
      totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
    });
    const result = await runAgentSession(config({ tokenBudget: guard }));
    expect(result.outcome).toBe('error');
    expect(result.stepsExecuted).toBe(1);
    expect(result.toolCallCount).toBe(1);
    expect(result.usage).toMatchObject({ promptTokens: 300, completionTokens: 40, totalTokens: 340, cacheReadTokens: 200 });
    // The guard committed the same segment once: (300 - 200) + 40 + 200 * 0.1.
    expect(guard.used()).toBe(160);
  });

  it('adds a failed attempt to the result of its retry', async () => {
    let calls = 0;
    mockStreamText.mockImplementation(() => {
      calls++;
      if (calls === 1) {
        return {
          fullStream: (async function* () {
            yield { type: 'finish-step', usage: { inputTokens: 100, outputTokens: 10 } };
            throw new Error('401 Unauthorized');
          })(),
          text: Promise.resolve(''),
          totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
        };
      }
      return streamResult({ inputTokens: 50, outputTokens: 5 });
    });
    const result = await runAgentSession(config(), { onAuthRefresh: async () => 'new-token' });
    expect(result.outcome).toBe('completed');
    expect(result.usage).toMatchObject({ promptTokens: 150, completionTokens: 15, totalTokens: 165 });
    expect(result.stepsExecuted).toBe(2);
  });

  it('leaves behaviour unchanged without a guard or limit', async () => {
    mockStreamText.mockReturnValue(streamResult());
    await runAgentSession(config());
    expect(Array.isArray(mockStreamText.mock.calls[0][0].stopWhen)).toBe(false);

    mockStreamText.mockReturnValue(streamResult());
    const guard = new TokenBudgetGuard({ readSpentTokens: () => 0 });
    const result = await runAgentSession(config({ tokenBudget: guard }));
    expect(Array.isArray(mockStreamText.mock.calls[1][0].stopWhen)).toBe(false);
    expect(result.outcome).toBe('completed');
  });
});
