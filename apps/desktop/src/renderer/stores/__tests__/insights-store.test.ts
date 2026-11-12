import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useInsightsStore, stopMessage } from '../insights-store';

const cancelInsights = vi.fn();

describe('insights-store stop', () => {
  beforeEach(() => {
    cancelInsights.mockClear();
    (globalThis as unknown as { window: Record<string, unknown> }).window =
      (globalThis as unknown as { window?: Record<string, unknown> }).window ?? {};
    (window as unknown as { electronAPI: unknown }).electronAPI = { cancelInsights };
    useInsightsStore.setState({
      session: null,
      status: { phase: 'idle', message: '' },
      streamingContent: '',
      streamingTasks: [],
      toolsUsed: []
    });
  });

  it.each(['thinking', 'streaming'] as const)('stopMessage cancels while %s', (phase) => {
    useInsightsStore.setState({ status: { phase, message: '' } });
    stopMessage('p1');
    expect(cancelInsights).toHaveBeenCalledWith('p1');
    expect(useInsightsStore.getState().status.phase).toBe(phase);
  });

  it.each(['idle', 'complete'] as const)('stopMessage does nothing when %s', (phase) => {
    useInsightsStore.setState({ status: { phase, message: '' } });
    stopMessage('p1');
    expect(cancelInsights).not.toHaveBeenCalled();
  });

  it('finalizeStreamingMessage(true) appends a stopped assistant message', () => {
    useInsightsStore.setState({ streamingContent: 'partial answer' });
    useInsightsStore.getState().finalizeStreamingMessage(true);

    const messages = useInsightsStore.getState().session?.messages ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('assistant');
    expect(messages[0].content).toBe('partial answer');
    expect(messages[0].stopped).toBe(true);
    expect(useInsightsStore.getState().streamingContent).toBe('');
  });

  it('finalizeStreamingMessage() leaves stopped undefined', () => {
    useInsightsStore.setState({ streamingContent: 'full answer' });
    useInsightsStore.getState().finalizeStreamingMessage();

    const messages = useInsightsStore.getState().session?.messages ?? [];
    expect(messages[0].stopped).toBeUndefined();
  });
});
