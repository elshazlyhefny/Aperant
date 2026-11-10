/**
 * @vitest-environment jsdom
 *
 * Queue promotion is main-process only: the board must never promote queued
 * tasks itself when a task leaves in_progress.
 */
import '@testing-library/jest-dom/vitest';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../../hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { KanbanBoard } from '../KanbanBoard';
import { ViewStateProvider } from '../../contexts/ViewStateContext';
import { TooltipProvider } from '../ui/tooltip';
import { useTaskStore } from '../../stores/task-store';

beforeAll(() => {
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  };
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  };
});

const makeTask = (id: string, status: string) =>
  ({
    id,
    specId: id,
    projectId: 'p1',
    title: id,
    description: '',
    status,
    subtasks: [],
    logs: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as never;

describe('KanbanBoard queue', () => {
  it('does not call updateTaskStatus when a task leaves in_progress', () => {
    const updateTaskStatus = vi.fn().mockResolvedValue({ success: true });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      updateTaskStatus,
      getTaskQueueState: vi.fn().mockResolvedValue({ success: false }),
    };
    const ui = (tasks: never[]) => (
      <TooltipProvider>
        <ViewStateProvider>
          <KanbanBoard tasks={tasks} onTaskClick={vi.fn()} />
        </ViewStateProvider>
      </TooltipProvider>
    );
    const before = [makeTask('a', 'in_progress'), makeTask('q1', 'queue'), makeTask('q2', 'queue')] as never[];
    useTaskStore.setState({ tasks: before });
    const { rerender } = render(ui(before));

    const after = [makeTask('a', 'human_review'), makeTask('q1', 'queue'), makeTask('q2', 'queue')] as never[];
    useTaskStore.setState({ tasks: after });
    rerender(ui(after));

    expect(updateTaskStatus).not.toHaveBeenCalled();
  });
});
