/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/app',
    getPath: () => '/tmp',
    isPackaged: false
  }
}));

const mockRunInsightsQuery = vi.fn();
vi.mock('../ai/runners/insights', () => ({
  runInsightsQuery: (...args: unknown[]) => mockRunInsightsQuery(...args)
}));

vi.mock('../rate-limit-detector', () => ({
  detectRateLimit: () => ({ isRateLimited: false }),
  createSDKRateLimitInfo: vi.fn()
}));

import { InsightsExecutor } from '../insights/insights-executor';
import type { InsightsConfig } from '../insights/config';

type OnStream = (event: Record<string, unknown>) => void;

function abortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

/** Mock run: streams "partial", then waits for abort and rejects or resolves. */
function pendingRun(mode: 'reject' | 'resolve') {
  mockRunInsightsQuery.mockImplementationOnce(
    (config: { abortSignal: AbortSignal }, onStream: OnStream) =>
      new Promise((resolve, reject) => {
        onStream({ type: 'text-delta', text: 'partial' });
        config.abortSignal.addEventListener('abort', () => {
          onStream({ type: 'error', error: 'aborted' });
          if (mode === 'reject') reject(abortError());
          else resolve({ text: '', taskSuggestion: null, toolCalls: [] });
        });
      })
  );
}

describe('InsightsExecutor stop', () => {
  let executor: InsightsExecutor;
  let chunks: Array<Record<string, unknown>>;
  let statuses: Array<Record<string, unknown>>;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new InsightsExecutor({} as InsightsConfig);
    chunks = [];
    statuses = [];
    executor.on('stream-chunk', (_id, chunk) => chunks.push(chunk));
    executor.on('status', (_id, status) => statuses.push(status));
  });

  for (const mode of ['reject', 'resolve'] as const) {
    it(`stopSession ends the run cleanly when the runner ${mode}s on abort`, async () => {
      pendingRun(mode);
      const run = executor.execute('p1', '/project', 'hi', []);

      expect(executor.stopSession('p1')).toBe(true);
      const result = await run;

      expect(result.stopped).toBe(true);
      expect(result.fullResponse).toBe('partial');
      expect(result.suggestedTasks).toBeUndefined();
      expect(chunks.some((c) => c.type === 'done' && c.stopped === true)).toBe(true);
      expect(chunks.some((c) => c.type === 'error')).toBe(false);
      expect(statuses[statuses.length - 1]).toEqual({ phase: 'complete' });
      expect(executor.isSessionActive('p1')).toBe(false);
    });
  }

  it('a superseded run emits no done or complete', async () => {
    pendingRun('reject');
    const first = executor.execute('p1', '/project', 'one', []);
    mockRunInsightsQuery.mockResolvedValueOnce({ text: 'second', taskSuggestion: null, toolCalls: [] });
    const second = await executor.execute('p1', '/project', 'two', []);
    const firstResult = await first;

    expect(firstResult.stopped).toBe(false);
    expect(second.stopped).toBe(false);
    // Only the second run produces one done chunk and one complete status
    expect(chunks.filter((c) => c.type === 'done')).toHaveLength(1);
    expect(chunks.some((c) => c.type === 'error')).toBe(false);
    expect(statuses.filter((s) => s.phase === 'complete')).toHaveLength(1);
  });

  it('a normal run returns stopped: false', async () => {
    mockRunInsightsQuery.mockResolvedValueOnce({ text: 'ok', taskSuggestion: null, toolCalls: [] });
    const result = await executor.execute('p1', '/project', 'hi', []);
    expect(result.stopped).toBe(false);
    expect(result.fullResponse).toBe('ok');
    expect(chunks.find((c) => c.type === 'done')?.stopped).toBeUndefined();
  });

  it('stopSession with no active run returns false', () => {
    expect(executor.stopSession('p1')).toBe(false);
  });
});
