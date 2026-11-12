import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageAttachment, InsightsModelConfig, InsightsSession } from '../../../shared/types';
import { getLastUserMessage, retryLastMessage, sendMessage, useInsightsStore } from '../insights-store';

const sendInsightsMessage = vi.fn();
const modelConfig = { profileId: 'balanced', model: 'sonnet', thinkingLevel: 'medium' } as unknown as InsightsModelConfig;

const fullImage = { id: 'img-1', filename: 'a.png', mimeType: 'image/png', size: 3, data: 'BASE64' } as unknown as ImageAttachment;
const thumbImage = { ...fullImage, data: undefined } as ImageAttachment;

function makeSession(): InsightsSession {
  return {
    id: 'session-1',
    projectId: 'p1',
    modelConfig,
    messages: [
      { id: 'm1', role: 'user', content: 'first', timestamp: new Date() },
      { id: 'm2', role: 'assistant', content: 'answer', timestamp: new Date() },
      { id: 'm3', role: 'user', content: 'last question', timestamp: new Date(), images: [thumbImage] },
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
  } as InsightsSession;
}

describe('insights-store retryLastMessage', () => {
  beforeEach(() => {
    sendInsightsMessage.mockReset();
    (globalThis as unknown as { window: unknown }).window = {
      ...((globalThis as { window?: object }).window ?? {}),
      electronAPI: { sendInsightsMessage },
    };
    useInsightsStore.setState({
      session: makeSession(),
      status: { phase: 'error', error: 'boom' },
      streamingContent: 'partial',
      streamingTasks: [],
      toolsUsed: [{ name: 'Read', timestamp: new Date() }],
      currentTool: { name: 'Read' },
      lastSent: null,
    });
  });

  it('resends the last user message without adding a message', () => {
    useInsightsStore.setState({
      lastSent: { sessionId: 'session-1', message: 'last question', images: [fullImage] },
    });
    const before = useInsightsStore.getState().session?.messages.length;

    retryLastMessage('p1');

    expect(useInsightsStore.getState().session?.messages.length).toBe(before);
    expect(sendInsightsMessage).toHaveBeenCalledWith('p1', 'last question', modelConfig, [fullImage], true);
  });

  it('clears partial output and sets thinking status', () => {
    retryLastMessage('p1');
    const state = useInsightsStore.getState();
    expect(state.streamingContent).toBe('');
    expect(state.toolsUsed).toEqual([]);
    expect(state.currentTool).toBeNull();
    expect(state.status.phase).toBe('thinking');
  });

  it.each(['thinking', 'streaming'] as const)('is a no-op while %s', (phase) => {
    useInsightsStore.setState({ status: { phase, message: '' } });
    retryLastMessage('p1');
    expect(sendInsightsMessage).not.toHaveBeenCalled();
    expect(useInsightsStore.getState().streamingContent).toBe('partial');
  });

  it('is a no-op with no user message', () => {
    useInsightsStore.setState({
      session: { ...makeSession(), messages: [{ id: 'a', role: 'assistant', content: 'hi', timestamp: new Date() }] },
    });
    retryLastMessage('p1');
    expect(sendInsightsMessage).not.toHaveBeenCalled();
  });

  it('is a no-op with no session', () => {
    useInsightsStore.setState({ session: null });
    retryLastMessage('p1');
    expect(sendInsightsMessage).not.toHaveBeenCalled();
  });

  it('falls back to the session message when lastSent is null', () => {
    retryLastMessage('p1');
    expect(sendInsightsMessage).toHaveBeenCalledWith('p1', 'last question', modelConfig, [thumbImage], true);
    expect(getLastUserMessage()).toEqual({ content: 'last question', images: [thumbImage] });
  });

  it('sendMessage records lastSent with full image data', () => {
    sendMessage('p1', 'new one', undefined, [fullImage]);
    expect(useInsightsStore.getState().lastSent).toEqual({
      sessionId: 'session-1',
      message: 'new one',
      images: [fullImage],
    });
    expect(getLastUserMessage()?.images[0].data).toBe('BASE64');
  });
});
