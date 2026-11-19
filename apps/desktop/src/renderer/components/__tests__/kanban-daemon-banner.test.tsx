/**
 * @vitest-environment jsdom
 *
 * The board shows the daemon banner while the queue state carries lockedBy.
 */
import '@testing-library/jest-dom/vitest';
import { act, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { holder?: string }) => `${key}:${opts?.holder ?? ''}`,
    i18n: { language: 'en' },
  }),
  Trans: ({ children }: { children: unknown }) => children,
}));
vi.mock('../../hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { KanbanBoard } from '../KanbanBoard';
import { ViewStateProvider } from '../../contexts/ViewStateContext';
import { TooltipProvider } from '../ui/tooltip';
import { useTaskStore } from '../../stores/task-store';
import { useTaskQueueStore } from '../../stores/task-queue-store';

beforeAll(() => {
  for (const name of ['ResizeObserver', 'IntersectionObserver']) {
    (globalThis as Record<string, unknown>)[name] = class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    };
  }
});

const task = {
  id: '001-a',
  specId: '001-a',
  projectId: 'p1',
  title: 'task a',
  description: '',
  status: 'in_progress',
  subtasks: [],
  logs: [],
  createdAt: new Date(),
  updatedAt: new Date(),
} as never;

const baseState = {
  projectId: 'p1',
  maxParallelTasks: 3,
  inProgressCount: 1,
  queuedTaskIds: [],
  skippedTaskIds: [],
};

describe('KanbanBoard daemon banner', () => {
  it('shows the banner while locked and removes it without remount', () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      getTaskQueueState: vi.fn().mockResolvedValue({ success: false }),
    };
    useTaskStore.setState({ tasks: [task] });
    useTaskQueueStore.setState({
      statesByProject: {
        p1: { ...baseState, lockedBy: 'daemon (pid 4123 on host X)', lockedTaskIds: ['001-a'] },
      },
    });
    render(
      <TooltipProvider>
        <ViewStateProvider>
          <KanbanBoard tasks={[task]} onTaskClick={vi.fn()} />
        </ViewStateProvider>
      </TooltipProvider>
    );
    expect(screen.getByText('kanban.daemonQueue.title:daemon (pid 4123 on host X)')).toBeInTheDocument();
    expect(screen.getByTestId('daemon-task-001-a')).toBeInTheDocument();

    act(() => {
      useTaskQueueStore.setState({ statesByProject: { p1: { ...baseState } } });
    });
    expect(screen.queryByText(/kanban\.daemonQueue\.title/)).toBeNull();
    expect(screen.queryByTestId('daemon-task-001-a')).toBeNull();
  });
});
