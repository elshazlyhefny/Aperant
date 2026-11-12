/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { InsightsSession } from '../../../shared/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' }
  })
}));

// jsdom has no layout: render a plain viewport div and hand it to the component
vi.mock('../ui/scroll-area', () => ({
  ScrollArea: ({
    children,
    onViewportRef
  }: {
    children: React.ReactNode;
    onViewportRef?: (el: HTMLElement | null) => void;
  }) => (
    <div data-testid="viewport" ref={onViewportRef}>
      {children}
    </div>
  )
}));

vi.mock('../ChatHistorySidebar', () => ({ ChatHistorySidebar: () => null }));
vi.mock('../InsightsModelSelector', () => ({ InsightsModelSelector: () => null }));
vi.mock('../ScreenshotCapture', () => ({ ScreenshotCapture: () => null }));
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}));
vi.mock('remark-gfm', () => ({ default: () => undefined }));

vi.mock('../../stores/insights-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/insights-store')>();
  return {
    ...actual,
    loadInsightsSession: vi.fn(),
    loadInsightsSessions: vi.fn(),
    setupInsightsListeners: vi.fn(() => () => {}),
    sendMessage: vi.fn()
  };
});

import { Insights } from '../Insights';
import { useInsightsStore } from '../../stores/insights-store';

let scrollHeight = 2000;
const clientHeight = 500;

function makeSession(messageCount: number): InsightsSession {
  return {
    id: 's1',
    projectId: 'p1',
    messages: Array.from({ length: messageCount }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `message ${i}`,
      timestamp: new Date(0)
    })),
    createdAt: new Date(0),
    updatedAt: new Date(0)
  };
}

function setStore(
  phase: 'idle' | 'streaming',
  messageCount = 2
) {
  useInsightsStore.setState({
    session: makeSession(messageCount),
    status: { phase },
    streamingContent: '',
    currentTool: null
  });
}

function renderInsights() {
  const utils = render(<Insights projectId="p1" />);
  const viewport = screen.getByTestId('viewport');
  Object.defineProperty(viewport, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(viewport, 'clientHeight', { configurable: true, get: () => clientHeight });
  return { ...utils, viewport };
}

function scrollUp(viewport: HTMLElement) {
  act(() => {
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
  });
}

describe('Insights auto-scroll', () => {
  beforeEach(() => {
    scrollHeight = 2000;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    (window as unknown as { electronAPI: unknown }).electronAPI = {};
    setStore('streaming');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('scrolls to the bottom on mount', () => {
    const { viewport } = renderInsights();
    // Mount effects ran before heights were defined; trigger a content change
    act(() => useInsightsStore.getState().appendStreamingContent('x'));
    expect(viewport.scrollTop).toBe(2000);
  });

  it('follows growing content while streaming', () => {
    const { viewport } = renderInsights();
    scrollHeight = 3000;
    act(() => useInsightsStore.getState().appendStreamingContent('more'));
    expect(viewport.scrollTop).toBe(3000);
  });

  it('scrolls when a new message arrives', () => {
    const { viewport } = renderInsights();
    scrollHeight = 2600;
    act(() => useInsightsStore.setState({ session: makeSession(3) }));
    expect(viewport.scrollTop).toBe(2600);
  });

  it('does not scroll when the user has scrolled up, and shows the jump button', () => {
    const { viewport } = renderInsights();
    scrollUp(viewport);
    scrollHeight = 3000;
    act(() => useInsightsStore.getState().appendStreamingContent('more'));
    expect(viewport.scrollTop).toBe(0);
    expect(screen.getByLabelText('insights.jumpToLatest')).toBeTruthy();
  });

  it('jump button scrolls to the bottom and disappears', () => {
    const { viewport } = renderInsights();
    scrollUp(viewport);
    fireEvent.click(screen.getByLabelText('insights.jumpToLatest'));
    expect(viewport.scrollTop).toBe(scrollHeight);
    expect(screen.queryByLabelText('insights.jumpToLatest')).toBeNull();
  });

  it('hides the jump button when at the bottom', () => {
    renderInsights();
    expect(screen.queryByLabelText('insights.jumpToLatest')).toBeNull();
  });

  it('hides the jump button when scrolled up but idle', () => {
    setStore('idle');
    const { viewport } = renderInsights();
    scrollUp(viewport);
    expect(screen.queryByLabelText('insights.jumpToLatest')).toBeNull();
  });
});
