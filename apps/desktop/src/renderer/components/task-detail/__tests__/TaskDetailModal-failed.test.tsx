/**
 * @vitest-environment jsdom
 *
 * zeenha fork: the detail view of a task that failed before any work shows
 * the Failed panel and no review / Create PR section; a real Human Review
 * still shows the review section.
 */
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('../../../hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('../../../stores/task-store', () => ({
  stopTask: vi.fn(), submitReview: vi.fn(), recoverStuckTask: vi.fn(), deleteTask: vi.fn(),
  startTaskOrQueue: vi.fn(), retryFailedTask: vi.fn(), replanFailedTask: vi.fn(),
  useTaskStore: { getState: () => ({ updateTask: vi.fn() }) },
}));
vi.mock('../../../stores/project-store', () => ({ useProjectStore: () => null }));
vi.mock('../../TaskEditDialog', () => ({ TaskEditDialog: () => null }));
vi.mock('../TaskFileOverlap', () => ({ TaskFileOverlap: () => null }));
vi.mock('../TaskMetadata', () => ({ TaskMetadata: () => null }));
vi.mock('../TaskSubtasks', () => ({ TaskSubtasks: () => null }));
vi.mock('../TaskLogs', () => ({ TaskLogs: () => null }));
vi.mock('../TaskFiles', () => ({ TaskFiles: () => null }));
vi.mock('../TaskReview', () => ({ TaskReview: () => <div data-testid="task-review">Create PR</div> }));
vi.mock('../hooks/useTaskDetail', () => ({
  useTaskDetail: ({ task }: { task: { status: string } }) =>
    new Proxy(
      { needsReview: task.status === 'human_review', isRunning: false, isStuck: false, isIncomplete: false, activeTab: 'overview' },
      { get: (target, key) => (key in target ? target[key as keyof typeof target] : vi.fn()) }
    ),
}));

import { TaskDetailModal } from '../TaskDetailModal';

const task = (o: Record<string, unknown>) =>
  ({
    id: 't1', specId: '025-x', projectId: 'p1', title: 'T', description: '', subtasks: [], logs: [],
    createdAt: new Date(), updatedAt: new Date(), ...o,
  }) as never;

describe('TaskDetailModal', () => {
  it('a failed task shows the Failed panel and no Create PR', () => {
    render(<TaskDetailModal open task={task({ status: 'error', failureReason: 'boom' })} onOpenChange={() => {}} />);
    expect(screen.getByTestId('failed-task-panel')).toBeInTheDocument();
    expect(screen.getByTestId('failed-task-reason')).toHaveTextContent('boom');
    expect(screen.queryByTestId('task-review')).not.toBeInTheDocument();
  });

  it('a real Human Review shows the review section and no Failed panel', () => {
    render(<TaskDetailModal open task={task({ status: 'human_review', reviewReason: 'completed' })} onOpenChange={() => {}} />);
    expect(screen.getByTestId('task-review')).toBeInTheDocument();
    expect(screen.queryByTestId('failed-task-panel')).not.toBeInTheDocument();
  });
});
