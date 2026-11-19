/**
 * @vitest-environment jsdom
 *
 * zeenha fork: the detail modal offers "Stop on daemon" for a daemon-run task
 * and never calls the local stopTask.
 */
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
const stopTask = vi.fn();
vi.mock('../../../hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('../../../stores/task-store', () => ({
  stopTask: (...a: unknown[]) => stopTask(...a),
  submitReview: vi.fn(), recoverStuckTask: vi.fn(), deleteTask: vi.fn(),
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
vi.mock('../TaskReview', () => ({ TaskReview: () => null }));
vi.mock('../hooks/useTaskDetail', () => ({
  useTaskDetail: () =>
    new Proxy(
      { isRunning: true, isStuck: true, isIncomplete: false, needsReview: false, activeTab: 'overview' },
      { get: (target, key) => (key in target ? target[key as keyof typeof target] : vi.fn()) }
    ),
}));

import { TaskDetailModal } from '../TaskDetailModal';
import { useTaskQueueStore } from '../../../stores/task-queue-store';
import { useDaemonStopStore } from '../../../stores/daemon-stop-store';

const task = {
  id: 't1', specId: '025-x', projectId: 'p1', title: 'T', description: '', status: 'in_progress',
  subtasks: [], logs: [], createdAt: new Date(), updatedAt: new Date(),
} as never;

const daemonStopTask = vi.fn();

beforeEach(() => {
  stopTask.mockReset();
  daemonStopTask.mockReset().mockResolvedValue({ success: true });
  (window as unknown as { electronAPI: unknown }).electronAPI = { daemonStopTask };
  useDaemonStopStore.setState({ pendingByTask: {}, errorByTask: {} });
  useTaskQueueStore.setState({ statesByProject: { p1: { lockedTaskIds: ['t1'] } } } as never);
});

describe('TaskDetailModal daemon stop', () => {
  it('shows Stop on daemon (even when the local agent looks stuck) and stops over IPC', async () => {
    render(<TaskDetailModal open task={task} onOpenChange={() => {}} />);
    expect(screen.queryByText('Recover Task')).not.toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByTestId('task-detail-daemon-stop')));
    expect(daemonStopTask).toHaveBeenCalledWith('t1');
    expect(stopTask).not.toHaveBeenCalled();
  });
});
