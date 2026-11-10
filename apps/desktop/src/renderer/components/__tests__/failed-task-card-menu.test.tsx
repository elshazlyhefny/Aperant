/**
 * @vitest-environment jsdom
 *
 * zeenha fork: the Retry and Re-plan items in a failed task card's ⋮ menu
 * (the "Fix" group) call the same store actions as the card's Retry button.
 */
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
const retryFailedTask = vi.fn();
const replanFailedTask = vi.fn();
const toast = vi.fn();
vi.mock('../../stores/task-store', () => ({
  useTaskStore: (selector: (s: { tasks: unknown[] }) => unknown) => selector({ tasks: [] }),
  retryFailedTask: (...a: unknown[]) => retryFailedTask(...a),
  replanFailedTask: (...a: unknown[]) => replanFailedTask(...a),
  startTaskOrQueue: vi.fn(),
  stopTask: vi.fn(),
  checkTaskRunning: vi.fn(),
  recoverStuckTask: vi.fn(),
  archiveTasks: vi.fn(),
  hasRecentActivity: vi.fn(() => false),
  isIncompleteHumanReview: () => false,
}));
vi.mock('../PhaseProgressIndicator', () => ({ PhaseProgressIndicator: () => null }));
vi.mock('../../hooks/use-toast', () => ({ useToast: () => ({ toast }) }));

import { TaskCard } from '../TaskCard';

// Radix's popper measures its content; jsdom has no ResizeObserver.
beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as Record<string, unknown>).ResizeObserver = class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    };
  }
});

const subtask = { id: 's1', title: '', description: '', status: 'pending', files: [] };
const task = (o: Record<string, unknown> = {}) =>
  ({
    id: 't1',
    specId: '025-x',
    projectId: 'p1',
    title: 'Failed task',
    description: 'desc',
    status: 'error',
    subtasks: [subtask],
    logs: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...o,
  }) as never;

/** Open the card's ⋮ menu the way a keyboard user does (Radix opens on Enter). */
function openMenu() {
  const trigger = screen.getByRole('button', { name: 'actions.taskActions' });
  fireEvent.keyDown(trigger, { key: 'Enter' });
}

beforeEach(() => {
  retryFailedTask.mockReset().mockResolvedValue({ success: true, action: 'started' });
  replanFailedTask.mockReset().mockResolvedValue({ success: true, action: 'started' });
  toast.mockReset();
});

describe('failed task card menu', () => {
  it('Retry in the menu retries the task without opening it', async () => {
    const onClick = vi.fn();
    render(<TaskCard task={task()} onClick={onClick} />);
    openMenu();

    expect(await screen.findByText('failedTask.fix')).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByTestId('task-card-menu-retry')));

    expect(retryFailedTask).toHaveBeenCalledWith('t1');
    expect(replanFailedTask).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('Re-plan in the menu re-plans the task', async () => {
    const onClick = vi.fn();
    render(<TaskCard task={task()} onClick={onClick} />);
    openMenu();

    await act(async () => fireEvent.click(await screen.findByTestId('task-card-menu-replan')));

    expect(replanFailedTask).toHaveBeenCalledWith('t1');
    expect(retryFailedTask).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('offers no Re-plan when there is no plan to discard', async () => {
    render(<TaskCard task={task({ subtasks: [] })} onClick={vi.fn()} />);
    openMenu();

    expect(await screen.findByTestId('task-card-menu-retry')).toBeInTheDocument();
    expect(screen.queryByTestId('task-card-menu-replan')).not.toBeInTheDocument();
  });

  it('shows the error when Re-plan is refused', async () => {
    replanFailedTask.mockResolvedValue({ success: false, error: 'Only a failed task can be re-planned' });
    render(<TaskCard task={task()} onClick={vi.fn()} />);
    openMenu();

    await act(async () => fireEvent.click(await screen.findByTestId('task-card-menu-replan')));

    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Only a failed task can be re-planned', variant: 'destructive' })
    );
  });

  it('a task that is not failed has no Fix group', async () => {
    render(<TaskCard task={task({ status: 'backlog' })} onClick={vi.fn()} onStatusChange={vi.fn()} />);
    openMenu();

    expect(await screen.findByText('actions.moveTo')).toBeInTheDocument();
    expect(screen.queryByText('failedTask.fix')).not.toBeInTheDocument();
    expect(screen.queryByTestId('task-card-menu-retry')).not.toBeInTheDocument();
  });
});
