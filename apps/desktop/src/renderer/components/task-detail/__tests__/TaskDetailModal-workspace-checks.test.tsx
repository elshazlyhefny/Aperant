/**
 * @vitest-environment jsdom
 *
 * zeenha fork: verify that Human Review distinguishes failed workspace checks
 * from confirmed absence and retries only the failed check.
 */
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, Task, WorktreeStatus } from '../../../../shared/types';
import { TaskDetailModal } from '../TaskDetailModal';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('../../../hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('../../../stores/task-store', () => ({
  stopTask: vi.fn(),
  submitReview: vi.fn(),
  recoverStuckTask: vi.fn(),
  deleteTask: vi.fn(),
  startTaskOrQueue: vi.fn(),
  persistTaskStatus: vi.fn(),
  loadTasks: vi.fn(),
  checkTaskRunning: vi.fn().mockResolvedValue(false),
  hasRecentActivity: () => false,
  isIncompleteHumanReview: () => false,
  getTaskProgress: () => ({ completed: 0, total: 0 }),
  useTaskStore: { getState: () => ({ updateTask: vi.fn() }) },
}));
vi.mock('../../../stores/project-store', () => {
  const state = { activeProjectId: null, selectedProjectId: null, projects: [], getActiveProject: () => null };
  return { useProjectStore: (select: (value: typeof state) => unknown) => select(state) };
});
vi.mock('../../../stores/settings-store', () => {
  const state = {
    settings: { logOrder: 'chronological', preferredIDE: 'vscode', preferredTerminal: 'system' },
  } satisfies { settings: Pick<AppSettings, 'logOrder' | 'preferredIDE' | 'preferredTerminal'> };
  return { useSettingsStore: (select?: (value: typeof state) => unknown) => (select ? select(state) : state) };
});
vi.mock('../../TaskEditDialog', () => ({ TaskEditDialog: () => null }));
vi.mock('../TaskFileOverlap', () => ({ TaskFileOverlap: () => null }));
vi.mock('../TaskMetadata', () => ({ TaskMetadata: () => null }));
vi.mock('../TaskSubtasks', () => ({ TaskSubtasks: () => null }));
vi.mock('../TaskLogs', () => ({ TaskLogs: () => null }));
vi.mock('../TaskFiles', () => ({ TaskFiles: () => null }));

const task: Task = {
  id: 't1',
  specId: '169-x',
  projectId: 'p1',
  title: 'Review task',
  description: '',
  status: 'human_review',
  reviewReason: 'completed',
  subtasks: [],
  logs: [],
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const workspace: WorktreeStatus = {
  exists: true,
  worktreePath: '/wt',
  branch: 'task/x',
  filesChanged: 3,
  commitCount: 2,
  additions: 17,
  deletions: 5,
};

function mockElectronAPI() {
  return {
    getWorktreeStatus: vi.fn<typeof window.electronAPI.getWorktreeStatus>()
      .mockResolvedValue({ success: true, data: workspace }),
    getWorktreeDiff: vi.fn<typeof window.electronAPI.getWorktreeDiff>()
      .mockResolvedValue({
        success: true,
        data: {
          files: [{ path: 'changed.ts', status: 'modified', additions: 1, deletions: 0 }],
          summary: '1 file changed',
        },
      }),
    onMergeProgress: vi.fn(() => vi.fn()),
    getTaskLogs: vi.fn().mockResolvedValue({ success: false }),
    watchTaskLogs: vi.fn(),
    unwatchTaskLogs: vi.fn(),
    onTaskLogsChanged: vi.fn(() => vi.fn()),
    onTaskLogsAppended: vi.fn(() => vi.fn()),
  };
}

function renderReview() {
  render(<TaskDetailModal open task={task} onOpenChange={vi.fn()} />);
}

describe('TaskDetailModal workspace checks', () => {
  let api: ReturnType<typeof mockElectronAPI>;

  beforeEach(() => {
    api = mockElectronAPI();
    vi.stubGlobal('electronAPI', api);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the no-workspace flow without retry buttons when absence is confirmed', async () => {
    api.getWorktreeStatus.mockResolvedValue({ success: true, data: { exists: false } });
    api.getWorktreeDiff.mockResolvedValue({ success: false, error: 'No worktree found for this task' });

    renderReview();

    expect(await screen.findByRole('heading', { name: 'No Workspace Found' })).toBeInTheDocument();
    expect(screen.queryByTestId('retry-workspace-status')).not.toBeInTheDocument();
    expect(screen.queryByTestId('retry-workspace-diff')).not.toBeInTheDocument();
    expect(api.getWorktreeStatus).toHaveBeenCalledWith(task.id);
    expect(api.getWorktreeDiff).toHaveBeenCalledWith(task.id);
  });

  it('shows a status failure instead of assuming absence and recovers on retry', async () => {
    api.getWorktreeStatus.mockRejectedValueOnce(new Error('Status lookup failed'));

    renderReview();

    const retry = await screen.findByTestId('retry-workspace-status');
    expect(screen.getByText('taskReview:workspaceCheck.statusFailedTitle')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'No Workspace Found' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('retry-workspace-diff')).not.toBeInTheDocument();
    fireEvent.click(retry);

    expect(await screen.findByRole('heading', { name: 'Build Ready for Review' })).toBeInTheDocument();
    expect(screen.getByText('task/x')).toBeInTheDocument();
    expect(screen.queryByTestId('retry-workspace-status')).not.toBeInTheDocument();
    expect(api.getWorktreeStatus).toHaveBeenCalledTimes(2);
    expect(api.getWorktreeDiff).toHaveBeenCalledTimes(1);
  });

  it('keeps status counts visible during a diff failure and retries only the diff', async () => {
    api.getWorktreeDiff.mockResolvedValueOnce({ success: false, error: 'git failed' });

    renderReview();

    const retry = await screen.findByTestId('retry-workspace-diff');
    expect(screen.getByText('taskReview:workspaceCheck.diffFailedTitle')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Build Ready for Review' })).toBeInTheDocument();
    for (const count of [workspace.filesChanged, workspace.commitCount, workspace.additions, workspace.deletions]) {
      expect(screen.getByText(String(count))).toBeInTheDocument();
    }
    const view = screen.getByRole('button', { name: 'View' });
    expect(view).toBeDisabled();
    fireEvent.click(retry);

    await waitFor(() => expect(screen.getByRole('button', { name: 'View' })).toBeEnabled());
    expect(screen.queryByText('taskReview:workspaceCheck.diffFailedTitle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('retry-workspace-diff')).not.toBeInTheDocument();
    expect(api.getWorktreeStatus).toHaveBeenCalledTimes(1);
    expect(api.getWorktreeDiff).toHaveBeenCalledTimes(2);
  });
});
