import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { SessionConfig, SessionResult, StreamEvent } from '../types';

// =============================================================================
// Mock AI SDK
// =============================================================================

// Create controllable mock for streamText
const mockStreamText = vi.fn();
vi.mock('ai', () => ({
  streamText: (...args: unknown[]) => mockStreamText(...args),
  stepCountIs: (n: number) => ({ type: 'stepCount', count: n }),
}));

// Import after mocking
import { buildPromptCacheKey, runAgentSession } from '../runner';
import type { RunnerOptions } from '../runner';

// =============================================================================
// Helpers
// =============================================================================

function createMockConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    agentType: 'coder',
    model: {} as SessionConfig['model'],
    systemPrompt: 'You are a helpful assistant.',
    initialMessages: [{ role: 'user', content: 'Hello' }],
    toolContext: {} as SessionConfig['toolContext'],
    maxSteps: 10,
    specDir: '/specs/001',
    projectDir: '/project',
    ...overrides,
  };
}

/**
 * Create a mock streamText result that yields the given parts.
 */
function createMockStreamResult(
  parts: Array<Record<string, unknown>>,
  options?: { text?: string; totalUsage?: { inputTokens: number; outputTokens: number } },
) {
  return {
    fullStream: (async function* () {
      for (const part of parts) {
        yield part;
      }
    })(),
    text: Promise.resolve(options?.text ?? ''),
    totalUsage: Promise.resolve(
      options?.totalUsage ?? { inputTokens: 100, outputTokens: 50 },
    ),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('runAgentSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Basic completion
  // ===========================================================================

  it('should return completed result for simple session', async () => {
    mockStreamText.mockReturnValue(
      createMockStreamResult(
        [
          { type: 'text-delta', id: 'text-1', delta: 'Hello world' },
          {
            type: 'finish-step',
            usage: { inputTokens: 50, outputTokens: 25 },
          },
        ],
        { text: 'Hello world', totalUsage: { inputTokens: 50, outputTokens: 25 } },
      ),
    );

    const result = await runAgentSession(createMockConfig());

    expect(result.outcome).toBe('completed');
    expect(result.stepsExecuted).toBe(1);
    expect(result.usage.promptTokens).toBe(50);
    expect(result.usage.completionTokens).toBe(25);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.messages).toHaveLength(2); // initial + assistant response
  });

  // ===========================================================================
  // Usage when result.totalUsage is unavailable (zeenha fork)
  // ===========================================================================

  describe('usage fallback', () => {
    const v6Steps = [
      { type: 'finish-step', usage: { inputTokens: 1000, outputTokens: 40, inputTokenDetails: { cacheReadTokens: 900 } } },
      { type: 'finish-step', usage: { inputTokens: 1100, outputTokens: 60, inputTokenDetails: { cacheReadTokens: 1000 } } },
    ];

    it('uses the per-step tally when result.totalUsage rejects', async () => {
      const rejecting = Promise.reject(new Error('stream closed without a finish event'));
      rejecting.catch(() => {}); // the runner awaits it later; avoid an unhandled-rejection warning first
      mockStreamText.mockReturnValue({ ...createMockStreamResult(v6Steps, { text: 'done' }), totalUsage: rejecting });

      const result = await runAgentSession(createMockConfig());

      expect(result.usage).toEqual({
        promptTokens: 2100,
        completionTokens: 100,
        totalTokens: 2200,
        cacheReadTokens: 1900,
      });
    });

    it('uses the per-step tally when result.totalUsage is empty', async () => {
      mockStreamText.mockReturnValue(
        createMockStreamResult(v6Steps, { text: 'done', totalUsage: { inputTokens: 0, outputTokens: 0 } }),
      );

      const result = await runAgentSession(createMockConfig());

      expect(result.usage.promptTokens).toBe(2100);
      expect(result.usage.completionTokens).toBe(100);
    });

    it('reads the cache split from the AI SDK v6 total', async () => {
      mockStreamText.mockReturnValue({
        ...createMockStreamResult(v6Steps, { text: 'done' }),
        totalUsage: Promise.resolve({
          inputTokens: 2100,
          outputTokens: 100,
          inputTokenDetails: { cacheReadTokens: 1900, cacheWriteTokens: 50 },
        }),
      });

      const result = await runAgentSession(createMockConfig());

      expect(result.usage).toEqual({
        promptTokens: 2100,
        completionTokens: 100,
        totalTokens: 2200,
        cacheReadTokens: 1900,
        cacheCreationTokens: 50,
      });
    });
  });

  // ===========================================================================
  // Max steps outcome
  // ===========================================================================

  it('should return max_steps when steps reach maxSteps', async () => {
    const steps = Array.from({ length: 10 }, (_) => ({
      type: 'finish-step',
      usage: { inputTokens: 10, outputTokens: 5 },
    }));

    mockStreamText.mockReturnValue(
      createMockStreamResult(steps, {
        text: 'done',
        totalUsage: { inputTokens: 100, outputTokens: 50 },
      }),
    );

    const result = await runAgentSession(createMockConfig({ maxSteps: 10 }));
    expect(result.outcome).toBe('max_steps');
    expect(result.stepsExecuted).toBe(10);
  });

  // ===========================================================================
  // Multi-step with tool calls
  // ===========================================================================

  it('should track tool calls across multiple steps', async () => {
    mockStreamText.mockReturnValue(
      createMockStreamResult(
        [
          { type: 'tool-call', toolName: 'Bash', toolCallId: 'c1', input: { command: 'ls' } },
          { type: 'tool-result', toolCallId: 'c1', toolName: 'Bash', input: { command: 'ls' }, output: 'file.ts' },
          {
            type: 'finish-step',
            usage: { promptTokens: 50, completionTokens: 25 },
          },
          { type: 'tool-call', toolName: 'Read', toolCallId: 'c2', input: { file_path: 'file.ts' } },
          { type: 'tool-result', toolCallId: 'c2', toolName: 'Read', input: { file_path: 'file.ts' }, output: 'content' },
          {
            type: 'finish-step',
            usage: { promptTokens: 50, completionTokens: 25 },
          },
        ],
        { text: 'Done', totalUsage: { inputTokens: 100, outputTokens: 50 } },
      ),
    );

    const result = await runAgentSession(createMockConfig());

    expect(result.outcome).toBe('completed');
    expect(result.stepsExecuted).toBe(2);
    expect(result.toolCallCount).toBe(2);
  });

  // ===========================================================================
  // Event callback
  // ===========================================================================

  it('should forward events to onEvent callback', async () => {
    const events: StreamEvent[] = [];

    mockStreamText.mockReturnValue(
      createMockStreamResult(
        [
          { type: 'text-delta', id: 'text-1', delta: 'hi' },
          {
            type: 'finish-step',
            usage: { inputTokens: 10, outputTokens: 5 },
          },
        ],
        { text: 'hi', totalUsage: { inputTokens: 10, outputTokens: 5 } },
      ),
    );

    await runAgentSession(createMockConfig(), {
      onEvent: (e) => events.push(e),
    });

    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'text-delta')).toBe(true);
    expect(events.some((e) => e.type === 'step-finish')).toBe(true);
  });

  // ===========================================================================
  // Error handling
  // ===========================================================================

  it('should classify rate limit errors', async () => {
    mockStreamText.mockImplementation(() => {
      throw new Error('429 Too Many Requests');
    });

    const result = await runAgentSession(createMockConfig());

    expect(result.outcome).toBe('rate_limited');
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('rate_limited');
    expect(result.stepsExecuted).toBe(0);
  });

  it('should classify generic errors', async () => {
    mockStreamText.mockImplementation(() => {
      throw new Error('Network error');
    });

    const result = await runAgentSession(createMockConfig());

    expect(result.outcome).toBe('error');
    expect(result.error!.code).toBe('generic_error');
  });

  // ===========================================================================
  // Auth retry
  // ===========================================================================

  it('should retry on auth failure when onAuthRefresh succeeds', async () => {
    let callCount = 0;
    mockStreamText.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        throw new Error('401 Unauthorized');
      }
      return createMockStreamResult(
        [
          { type: 'text-delta', id: 'text-1', delta: 'ok' },
          {
            type: 'finish-step',
            usage: { inputTokens: 10, outputTokens: 5 },
          },
        ],
        { text: 'ok', totalUsage: { inputTokens: 10, outputTokens: 5 } },
      );
    });

    const onAuthRefresh = vi.fn().mockResolvedValue('new-token');

    const result = await runAgentSession(createMockConfig(), { onAuthRefresh });

    expect(onAuthRefresh).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('completed');
  });

  it('should return auth_failure when onAuthRefresh returns null', async () => {
    mockStreamText.mockImplementation(() => {
      throw new Error('401 Unauthorized');
    });

    const result = await runAgentSession(createMockConfig(), {
      onAuthRefresh: vi.fn().mockResolvedValue(null),
    });

    expect(result.outcome).toBe('auth_failure');
  });

  it('should return auth_failure when no onAuthRefresh provided', async () => {
    mockStreamText.mockImplementation(() => {
      throw new Error('401 Unauthorized');
    });

    const result = await runAgentSession(createMockConfig());

    expect(result.outcome).toBe('auth_failure');
  });

  // ===========================================================================
  // Cancellation
  // ===========================================================================

  it('should return cancelled when abortSignal fires during stream', async () => {
    const controller = new AbortController();

    mockStreamText.mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'text-delta', id: 'text-1', delta: 'start' };
        controller.abort();
        throw new DOMException('aborted', 'AbortError');
      })(),
      text: Promise.resolve(''),
      totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
    });

    const result = await runAgentSession(
      createMockConfig({ abortSignal: controller.signal }),
    );

    expect(result.outcome).toBe('cancelled');
  });

  // ===========================================================================
  // streamText configuration
  // ===========================================================================

  it('should pass tools and system prompt to streamText', async () => {
    mockStreamText.mockReturnValue(
      createMockStreamResult([], { text: '', totalUsage: { inputTokens: 0, outputTokens: 0 } }),
    );

    const tools = { Bash: {} as any };
    await runAgentSession(createMockConfig({ systemPrompt: 'Be helpful' }), { tools });

    expect(mockStreamText).toHaveBeenCalledTimes(1);
    const callArgs = mockStreamText.mock.calls[0][0];
    expect(callArgs.system).toBe('Be helpful');
    expect(callArgs.tools).toBe(tools);
  });

  it('should use default maxSteps of 500 when not specified', async () => {
    mockStreamText.mockReturnValue(
      createMockStreamResult([], { text: '', totalUsage: { inputTokens: 0, outputTokens: 0 } }),
    );

    const config = createMockConfig();
    // @ts-expect-error - testing undefined maxSteps behavior
    delete config.maxSteps;

    await runAgentSession(config);

    const callArgs = mockStreamText.mock.calls[0][0];
    expect(callArgs.stopWhen).toEqual({ type: 'stepCount', count: 500 });
  });

  // ===========================================================================
  // Step notes and prompt caching (zeenha fork)
  // ===========================================================================

  describe('step notes', () => {
    const history = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Working on it' },
    ];

    async function prepareStepFor(config: SessionConfig, parts: Array<Record<string, unknown>> = []) {
      mockStreamText.mockReturnValue(createMockStreamResult(parts, { text: 'done' }));
      await runAgentSession(config);
      return mockStreamText.mock.calls[0][0].prepareStep as (args: {
        stepNumber: number;
        messages: unknown[];
      }) => Promise<Record<string, unknown>>;
    }

    it('adds the convergence nudge as a trailing user message and keeps the system prompt', async () => {
      const prepareStep = await prepareStepFor(createMockConfig({ agentType: 'qa_reviewer', maxSteps: 10 }));

      expect(await prepareStep({ stepNumber: 1, messages: history })).toEqual({});

      const result = await prepareStep({ stepNumber: 8, messages: history });
      expect(result.system).toBeUndefined();
      expect(result.messages).toEqual([
        ...history,
        { role: 'user', content: expect.stringContaining('You have used 8 of 10 steps') },
      ]);
    });

    it('adds the context window warning as a trailing user message', async () => {
      const prepareStep = await prepareStepFor(createMockConfig({ contextWindowLimit: 1000 }), [
        { type: 'finish-step', usage: { inputTokens: 870, outputTokens: 10 } },
      ]);

      const result = await prepareStep({ stepNumber: 2, messages: history });
      expect(result.system).toBeUndefined();
      expect(result.messages).toEqual([
        ...history,
        { role: 'user', content: expect.stringContaining('approaching the context window limit (87% used') },
      ]);
    });
  });

  describe('prompt cache key', () => {
    const run = async (model: Record<string, unknown>) => {
      mockStreamText.mockClear();
      mockStreamText.mockReturnValue(createMockStreamResult([], { text: 'done' }));
      await runAgentSession(createMockConfig({ model: model as unknown as SessionConfig['model'] }));
      return mockStreamText.mock.calls[0][0].providerOptions;
    };

    it('sends one key per task and agent type to OpenAI models, alongside the reasoning effort', async () => {
      mockStreamText.mockReturnValue(createMockStreamResult([], { text: 'done' }));
      await runAgentSession(
        createMockConfig({
          model: { provider: 'openai.responses', modelId: 'gpt-6.2-sol' } as unknown as SessionConfig['model'],
          thinkingLevel: 'high',
        }),
      );
      const first = mockStreamText.mock.calls[0][0].providerOptions;
      expect(first.openai).toEqual({ reasoningEffort: 'high', promptCacheKey: expect.stringMatching(/^[0-9a-f]{32}$/) });

      // A later session of the same agent on the same spec reuses the key.
      const second = await run({ provider: 'openai.responses', modelId: 'gpt-6.2-sol' });
      expect(second.openai.promptCacheKey).toBe(first.openai.promptCacheKey);
    });

    it('keys differ across agent types and specs, and fall back to random without a spec', () => {
      const coder = buildPromptCacheKey({ specDir: '/specs/001', agentType: 'coder' });
      expect(buildPromptCacheKey({ specDir: '/specs/001', agentType: 'coder' })).toBe(coder);
      expect(buildPromptCacheKey({ specDir: '/specs/001', agentType: 'qa_reviewer' })).not.toBe(coder);
      expect(buildPromptCacheKey({ specDir: '/specs/002', agentType: 'coder' })).not.toBe(coder);
      const a = buildPromptCacheKey({ specDir: '', agentType: 'coder' });
      expect(a).not.toBe(buildPromptCacheKey({ specDir: '', agentType: 'coder' }));
    });

    it('sends no key to other providers', async () => {
      const options = await run({ provider: 'anthropic.messages', modelId: 'claude-opus-5-5' });
      expect(options?.openai).toBeUndefined();
    });
  });
});
