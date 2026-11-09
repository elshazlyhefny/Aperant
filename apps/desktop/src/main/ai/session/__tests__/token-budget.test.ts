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
