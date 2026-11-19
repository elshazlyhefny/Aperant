/**
 * @vitest-environment jsdom
 *
 * zeenha fork: a daemon-run task card offers "Stop on daemon" (IPC) instead of
 * the local Stop, and shows pending / error states.
 */
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
const stopTask = vi.fn();
const toast = vi.fn();
vi.mock('../../stores/task-store', () => ({
  useTaskStore: (selector: (s: { tasks: unknown[] }) => unknown) => selector({ tasks: [] }),
  retryFailedTask: vi.fn(), replanFailedTask: vi.fn(), startTaskOrQueue: vi.fn(),
  stopTask: (...a: unknown[]) => stopTask(...a),
  checkTaskRunning: vi.fn(), recoverStuckTask: vi.fn(), archiveTasks: vi.fn(),
  hasRecentActivity: vi.fn(() => true),
  isIncompleteHumanReview: () => false,
}));
vi.mock('../PhaseProgressIndicator', () => ({ PhaseProgressIndicator: () => null }));
vi.mock('../../hooks/use-toast', () => ({ useToast: () => ({ toast }) }));

import { TaskCard } from '../TaskCard';
import { useTaskQueueStore } from '../../stores/task-queue-store';
import { useDaemonStopStore } from '../../stores/daemon-stop-store';

const task = (o: Record<string, unknown> = {}) =>
  ({
    id: 't1', specId: '025-x', projectId: 'p1', title: 'Running task', description: 'desc',
    status: 'in_progress', subtasks: [], logs: [], createdAt: new Date(), updatedAt: new Date(), ...o,
  }) as never;

const daemonStopTask = vi.fn();

function lock(ids: string[]) {
  useTaskQueueStore.setState({ statesByProject: { p1: { lockedTaskIds: ids } } } as never);
}

beforeEach(() => {
  stopTask.mockReset();
  toast.mockReset();
  daemonStopTask.mockReset().mockResolvedValue({ success: true });
  (window as unknown as { electronAPI: unknown }).electronAPI = { daemonStopTask };
  useDaemonStopStore.setState({ pendingByTask: {}, errorByTask: {} });
  lock([]);
});

describe('daemon stop on task card', () => {
  it('shows Stop on daemon, not the local Stop, for a daemon-run task', () => {
    lock(['t1']);
    render(<TaskCard task={task()} onClick={vi.fn()} />);
    expect(screen.getByText('daemonStop.stopOnDaemon')).toBeInTheDocument();
    expect(screen.queryByText('actions.stop')).not.toBeInTheDocument();
  });

  it('click calls daemonStopTask with the task id and never stopTask, then stays pending', async () => {
    lock(['t1']);
    const { rerender } = render(<TaskCard task={task()} onClick={vi.fn()} />);
    await act(async () => fireEvent.click(screen.getByTestId('task-card-daemon-stop')));
    expect(daemonStopTask).toHaveBeenCalledWith('t1');
    expect(stopTask).not.toHaveBeenCalled();
    expect(screen.getByTestId('task-card-daemon-stop')).toBeDisabled();
    expect(screen.getByText('daemonStop.stopping')).toBeInTheDocument();

    // the status change away from in_progress is the confirmation
    rerender(<TaskCard task={task({ status: 'human_review' })} onClick={vi.fn()} />);
    expect(useDaemonStopStore.getState().pendingByTask.t1).toBeUndefined();
  });

  it('shows an alert and keeps the button enabled after a failed result', async () => {
    lock(['t1']);
    daemonStopTask.mockResolvedValue({ success: false, error: 'no-daemon' });
    render(<TaskCard task={task()} onClick={vi.fn()} />);
    await act(async () => fireEvent.click(screen.getByTestId('task-card-daemon-stop')));
    expect(screen.getByRole('alert')).toHaveTextContent('daemonStop.errors.noDaemon');
    expect(screen.getByTestId('task-card-daemon-stop')).toBeEnabled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
  });

  it('a normal in_progress task still shows the local Stop', () => {
    render(<TaskCard task={task()} onClick={vi.fn()} />);
    expect(screen.getByText('actions.stop')).toBeInTheDocument();
    expect(screen.queryByText('daemonStop.stopOnDaemon')).not.toBeInTheDocument();
  });
});
