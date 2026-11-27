/**
 * @vitest-environment jsdom
 */
import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { Insights } from '../Insights';
import { createTaskFromSuggestion, useInsightsStore } from '../../stores/insights-store';
import type { InsightsChatMessage, InsightsSession, Task } from '../../../shared/types';

const mocks = vi.hoisted(() => ({
  t: (key: string) => key,
  markdownRenders: [] as string[],
  modelSelectorRenders: 0
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.t, i18n: { language: 'en' } })
}));

// jsdom has no layout: render a plain viewport div and hand it to the component.
vi.mock('../ui/scroll-area', () => ({
  ScrollArea: ({
    children,
    onViewportRef
  }: {
    children: ReactNode;
    onViewportRef?: (el: HTMLElement | null) => void;
  }) => (
    <div data-testid="viewport" ref={onViewportRef}>
      {children}
    </div>
  )
}));

vi.mock('../ChatHistorySidebar', () => ({ ChatHistorySidebar: () => null }));
vi.mock('../InsightsModelSelector', () => ({
  InsightsModelSelector: () => {
    mocks.modelSelectorRenders++;
    return null;
  }
}));
vi.mock('../ScreenshotCapture', () => ({ ScreenshotCapture: () => null }));
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => {
    mocks.markdownRenders.push(children);
    return <div>{children}</div>;
  }
}));
vi.mock('remark-gfm', () => ({ default: () => undefined }));

vi.mock('../../stores/insights-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/insights-store')>();
  return {
    ...actual,
    loadInsightsSession: vi.fn(),
    loadInsightsSessions: vi.fn(),
    setupInsightsListeners: vi.fn(() => () => undefined),
    sendMessage: vi.fn(),
    createTaskFromSuggestion: vi.fn().mockResolvedValue(null)
  };
});

const projectId = 'p1';
const timestamp = new Date(0);

function makeSession(replyCount: number): InsightsSession {
  return {
    id: 's1',
    projectId,
    messages: Array.from({ length: replyCount * 2 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `**Message ${i}**`,
      timestamp
    })),
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function resetRenderCounts() {
  mocks.markdownRenders.length = 0;
  mocks.modelSelectorRenders = 0;
}

function renderTranscript(session = makeSession(2)) {
  useInsightsStore.getState().setSession(session);
  const view = render(<Insights projectId={projectId} />);
  resetRenderCounts();
  return view;
}

describe('Insights render counts', () => {
  beforeEach(() => {
    mocks.t = (key) => key;
    resetRenderCounts();
    vi.clearAllMocks();
    vi.stubGlobal('electronAPI', { getTasks: vi.fn().mockResolvedValue({ success: true, data: [] }) });
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 0;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    useInsightsStore.setState(useInsightsStore.getInitialState());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([0, 50])('renders only the live markdown on stream updates with %i completed replies', (replyCount) => {
    const session = makeSession(replyCount);
    useInsightsStore.setState({ session, status: { phase: 'streaming' } });
    let commits = 0;
    let duration = 0;
    const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
      commits++;
      duration += actualDuration;
    };
    render(
      <Profiler id="insights" onRender={onRender}>
        <Insights projectId={projectId} />
      </Profiler>
    );
    commits = 0;
    duration = 0;
    resetRenderCounts();

    const chunks = ['A', ' live', ' **markdown**', ' response', '.'];
    const liveRenders: string[] = [];
    let liveContent = '';
    for (const chunk of chunks) {
      liveContent += chunk;
      liveRenders.push(liveContent);
      act(() => useInsightsStore.getState().appendStreamingContent(chunk));
    }

    // Opt-in diagnostics for before/after measurements; timings are too noisy to assert.
    if (process.env.INSIGHTS_PROFILE === '1') {
      const history = new Set(session.messages.map(({ content }) => content));
      const replies = new Set(session.messages.filter(({ role }) => role === 'assistant').map(({ content }) => content));
      const rendersPerChunk = (contents: Set<string>) =>
        mocks.markdownRenders.filter((content) => contents.has(content)).length / chunks.length;
      process.stdout.write(
        `Insights (${replyCount} replies): ${rendersPerChunk(history)} historical markdown renders/chunk ` +
        `(${rendersPerChunk(replies)} assistant), ${mocks.modelSelectorRenders} model selector renders, ` +
        `${commits} commits, ${duration.toFixed(2)} ms summed actualDuration\n`
      );
    }

    expect(commits).toBe(chunks.length);
    expect(mocks.markdownRenders).toEqual(liveRenders);
    expect(screen.getByText(liveContent)).toBeTruthy();
  });

  it('renders only the appended message markdown', () => {
    renderTranscript();
    const message: InsightsChatMessage = {
      id: 'new-reply',
      role: 'assistant',
      content: 'New reply',
      timestamp
    };

    act(() => useInsightsStore.getState().addMessage(message));

    expect(mocks.markdownRenders).toEqual([message.content]);
  });

  it('renders only the message replaced by a session update', () => {
    const session = makeSession(2);
    renderTranscript(session);
    const updated = { ...session.messages[1], content: 'Edited reply' };

    act(() => useInsightsStore.getState().setSession({
      ...session,
      messages: session.messages.map((message) => message.id === updated.id ? updated : message)
    }));

    expect(mocks.markdownRenders).toEqual([updated.content]);
    expect(screen.getByText(updated.content)).toBeTruthy();
  });

  it('renders all historical markdown when the translation function changes', () => {
    const session = makeSession(2);
    const { rerender } = renderTranscript(session);

    mocks.t = (key) => `fr:${key}`;
    rerender(<Insights projectId={projectId} />);

    expect(mocks.markdownRenders).toEqual(session.messages.map(({ content }) => content));
    expect(screen.getAllByText('fr:insights.roles.assistant')).toHaveLength(2);
  });

  it('updates the suggested-task card as task creation starts and completes', async () => {
    const session = makeSession(1);
    const suggestion = { title: 'Add tests', description: 'Cover the suggested change' };
    session.messages[1].suggestedTasks = [suggestion];
    const task: Task = {
      ...suggestion,
      id: 't1',
      specId: 's1',
      projectId,
      status: 'backlog',
      subtasks: [],
      logs: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    let resolveTask!: (task: Task) => void;
    const pendingTask = new Promise<Task>((resolve) => {
      resolveTask = resolve;
    });
    vi.mocked(createTaskFromSuggestion).mockReturnValueOnce(pendingTask);
    renderTranscript(session);

    fireEvent.click(screen.getByRole('button', { name: 'insights.createTask' }));

    expect(createTaskFromSuggestion).toHaveBeenCalledWith(projectId, suggestion.title, suggestion.description, undefined);
    expect((screen.getByRole('button', { name: 'insights.creating' }) as HTMLButtonElement).disabled).toBe(true);

    await act(() => resolveTask(task));

    expect((screen.getByRole('button', { name: 'insights.taskCreated' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
