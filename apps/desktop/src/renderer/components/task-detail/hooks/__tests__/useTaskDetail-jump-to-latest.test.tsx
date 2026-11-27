/**
 * @vitest-environment jsdom
 *
 * zeenha fork: exercise the live-edge button with the real scroll-follow state.
 */
import '@testing-library/jest-dom/vitest';
import type { Task, TaskLogs as PhaseLogs } from '@shared/types';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createRef, type Ref, useImperativeHandle } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '../../../../stores/settings-store';
import { TaskLogs } from '../../TaskLogs';
import { useTaskDetail } from '../useTaskDetail';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));
vi.mock('../../../../stores/project-store', () => ({
  useProjectStore: (select: (state: {
    activeProjectId: null;
    selectedProjectId: null;
    projects: [];
  }) => unknown) => select({ activeProjectId: null, selectedProjectId: null, projects: [] }),
}));
vi.mock('../../../../stores/task-store', () => ({
  checkTaskRunning: vi.fn(),
  isIncompleteHumanReview: vi.fn(() => false),
  getTaskProgress: vi.fn(),
  useTaskStore: vi.fn(),
  loadTasks: vi.fn(),
  hasRecentActivity: vi.fn(),
}));

const timestamp = '2026-01-01T00:00:00.000Z';
const task: Task = {
  id: 'jump-to-latest-task',
  specId: 'jump-to-latest-spec',
  projectId: 'test-project',
  title: 'Task with logs',
  description: '',
  status: 'backlog',
  subtasks: [],
  logs: [],
  createdAt: new Date(timestamp),
  updatedAt: new Date(timestamp),
};
const emptyPhase = { status: 'pending' as const, started_at: null, completed_at: null, entries: [] };
const initialLogs: PhaseLogs = {
  spec_id: task.specId,
  created_at: timestamp,
  updated_at: timestamp,
  phases: {
    planning: { ...emptyPhase, phase: 'planning' },
    coding: { ...emptyPhase, phase: 'coding', status: 'active' },
    validation: { ...emptyPhase, phase: 'validation' },
  },
};

type LogsControls = Pick<ReturnType<typeof useTaskDetail>,
  'setActiveTab' | 'setPhaseLogs' | 'logsContainerRef' | 'logsEndRef'
>;

function LogsHarness({ controls }: { controls: Ref<LogsControls> }) {
  const state = useTaskDetail({ task });
  useImperativeHandle(controls, () => ({
    setActiveTab: state.setActiveTab,
    setPhaseLogs: state.setPhaseLogs,
    logsContainerRef: state.logsContainerRef,
    logsEndRef: state.logsEndRef,
  }));

  if (state.activeTab !== 'logs') return null;

  return (
    <TaskLogs
      task={task}
      phaseLogs={state.phaseLogs}
      isLoadingLogs={state.isLoadingLogs}
      expandedPhases={state.expandedPhases}
      isStuck={state.isStuck}
      logsEndRef={state.logsEndRef}
      logsContainerRef={state.logsContainerRef}
      onLogsScroll={state.handleLogsScroll}
      onTogglePhase={state.togglePhase}
      isAwayFromLatest={state.isUserScrolledUp}
      onJumpToLatest={state.jumpToLatestLogs}
    />
  );
}

const scrollTo = vi.fn();
const scrollIntoView = vi.fn();
const jumpButtonId = 'task-logs-jump-to-latest';

describe.each(['chronological', 'reverse-chronological'] as const)('Task Logs in %s order', (logOrder) => {
  beforeEach(() => {
    const initialLogOrder = useSettingsStore.getState().settings.logOrder;
    useSettingsStore.setState(({ settings }) => ({ settings: { ...settings, logOrder } }));

    const prototype = HTMLElement.prototype;
    const originalScrollTo = Object.getOwnPropertyDescriptor(prototype, 'scrollTo');
    // The shared jsdom setup already defines a writable scrollIntoView stub.
    const originalScrollIntoView = prototype.scrollIntoView;
    Object.defineProperty(prototype, 'scrollTo', { configurable: true, value: scrollTo });
    prototype.scrollIntoView = scrollIntoView;

    return () => {
      if (originalScrollTo) Object.defineProperty(prototype, 'scrollTo', originalScrollTo);
      else Reflect.deleteProperty(prototype, 'scrollTo');
      prototype.scrollIntoView = originalScrollIntoView;
      useSettingsStore.setState(({ settings }) => ({ settings: { ...settings, logOrder: initialLogOrder } }));
    };
  });

  it('pauses on scroll-away, jumps back with focus, and follows the next append', () => {
    const controls = createRef<LogsControls>();
    render(<LogsHarness controls={controls} />);
    const state = controls.current;
    if (!state) throw new Error('Expected the log controls to be mounted');

    const { setActiveTab, setPhaseLogs, logsContainerRef, logsEndRef } = state;
    act(() => setActiveTab('logs'));
    const viewport = logsContainerRef.current;
    if (!viewport) throw new Error('Expected the log viewport to be mounted');
    Object.defineProperties(viewport, {
      scrollTop: { value: 0, writable: true },
      scrollHeight: { value: 5000 },
      clientHeight: { value: 400 },
    });
    const isReverse = logOrder === 'reverse-chronological';

    function appendLog(content: string) {
      act(() => setPhaseLogs(previous => {
        const logs = previous ?? initialLogs;
        const coding = logs.phases.coding;
        return {
          ...logs,
          phases: {
            ...logs.phases,
            coding: {
              ...coding,
              entries: [...coding.entries, { timestamp, type: 'text', content, phase: 'coding' }],
            },
          },
        };
      }));
    }

    function expectAutoFollow() {
      if (isReverse) {
        expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 0, behavior: 'smooth' });
        expect(scrollTo.mock.contexts[0]).toBe(viewport);
        expect(scrollIntoView).not.toHaveBeenCalled();
      } else {
        expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ behavior: 'smooth' });
        expect(scrollIntoView.mock.contexts[0]).toBe(logsEndRef.current);
        expect(scrollTo).not.toHaveBeenCalled();
      }
    }

    scrollTo.mockClear();
    appendLog('Initial log');
    expectAutoFollow();
    expect(screen.queryByTestId(jumpButtonId)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('tasks:execution.phases.coding'));

    viewport.scrollTop = 1000;
    fireEvent.scroll(viewport);
    const button = screen.getByTestId(jumpButtonId);

    scrollTo.mockClear();
    scrollIntoView.mockClear();
    appendLog('Log while paused');
    expect(screen.getByText('Log while paused')).toBeInTheDocument();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(viewport.scrollTop).toBe(1000);

    button.focus();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(viewport.scrollTop).toBe(isReverse ? 0 : viewport.scrollHeight);
    expect(screen.queryByTestId(jumpButtonId)).not.toBeInTheDocument();
    expect(viewport).toHaveFocus();

    // jsdom does not clamp scrollTop to the bottom before dispatching a scroll event.
    viewport.scrollTop = isReverse ? 0 : viewport.scrollHeight - viewport.clientHeight;
    fireEvent.scroll(viewport);
    expect(screen.queryByTestId(jumpButtonId)).not.toBeInTheDocument();

    scrollTo.mockClear();
    scrollIntoView.mockClear();
    appendLog('Log after jumping');
    expect(screen.getByText('Log after jumping')).toBeInTheDocument();
    expectAutoFollow();
  });
});
