/**
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPCResult, Task, WorktreeDiff, WorktreeMergeResult, WorktreeStatus } from '../../../../../shared/types';
import { useTaskDetail } from '../useTaskDetail';

vi.mock('../../../../stores/project-store', () => ({
  useProjectStore: (select: (state: { activeProjectId: null; selectedProjectId: null; projects: [] }) => unknown) =>
    select({ activeProjectId: null, selectedProjectId: null, projects: [] }),
}));

vi.mock('../../../../stores/settings-store', () => ({
  useSettingsStore: (select: (state: { settings: { logOrder: string } }) => unknown) =>
    select({ settings: { logOrder: 'chronological' } }),
}));

vi.mock('../../../../stores/task-store', () => ({
  checkTaskRunning: vi.fn().mockResolvedValue(false),
  isIncompleteHumanReview: () => false,
  getTaskProgress: () => ({ completed: 0, total: 0 }),
  useTaskStore: { getState: vi.fn() },
  loadTasks: vi.fn(),
  hasRecentActivity: () => false,
}));

const makeTask = (id: string): Task => ({
  id,
  specId: id,
  projectId: 'project',
  title: id,
  description: '',
  status: 'human_review',
  reviewReason: 'completed',
  subtasks: [],
  logs: [],
  createdAt: new Date(),
  updatedAt: new Date(),
});

const taskA = makeTask('a');
const taskB = makeTask('b');
const statusA: WorktreeStatus = { exists: true, worktreePath: '/worktrees/a' };
const statusB: WorktreeStatus = { exists: true, worktreePath: '/worktrees/b' };
const diffA: WorktreeDiff = { files: [], summary: 'Diff A' };
const diffB: WorktreeDiff = { files: [], summary: 'Diff B' };
const success = <T,>(data: T): IPCResult<T> => ({ success: true, data });
const checked = { state: 'success', error: null };

function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

function mockElectronAPI() {
  return {
    getWorktreeStatus: vi.fn<typeof window.electronAPI.getWorktreeStatus>().mockResolvedValue(success(statusA)),
    getWorktreeDiff: vi.fn<typeof window.electronAPI.getWorktreeDiff>().mockResolvedValue(success(diffA)),
    mergeWorktreePreview: vi.fn<typeof window.electronAPI.mergeWorktreePreview>()
      .mockResolvedValue(success({ success: true, message: '' })),
    checkWorktreeChanges: vi.fn().mockResolvedValue(success({ hasChanges: false })),
    getTaskLogs: vi.fn().mockResolvedValue({ success: false }),
    watchTaskLogs: vi.fn(),
    unwatchTaskLogs: vi.fn(),
    onTaskLogsChanged: vi.fn(() => vi.fn()),
    onTaskLogsAppended: vi.fn(() => vi.fn()),
  };
}

function renderTask(task: Task = taskA) {
  return renderHook(useTaskDetail, { initialProps: { task } });
}

describe('useTaskDetail workspace checks', () => {
  let api: ReturnType<typeof mockElectronAPI>;

  beforeEach(() => {
    api = mockElectronAPI();
    vi.stubGlobal('electronAPI', api);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('treats exists:false as a successful check even while the diff is pending', async () => {
    const diff = deferred<IPCResult<WorktreeDiff>>();
    api.getWorktreeStatus.mockResolvedValue(success({ exists: false }));
    api.getWorktreeDiff.mockReturnValue(diff.promise);

    const { result } = renderTask();
    await waitFor(() => expect(result.current.worktreeStatusCheck).toEqual(checked));
    expect(result.current.worktreeStatus?.exists).toBe(false);
    expect(result.current.isLoadingWorktree).toBe(false);
    expect(result.current.isLoadingWorktreeDiff).toBe(true);

    await act(async () => diff.resolve({ success: false, error: 'No worktree found for this task' }));
    expect(result.current.worktreeStatusCheck).toEqual(checked);
    expect(result.current.worktreeDiffCheck.state).toBe('error');
  });

  it('records a rejected status check without discarding a successful diff', async () => {
    api.getWorktreeStatus.mockRejectedValue(new Error('status unavailable'));
    const { result } = renderTask();

    await waitFor(() => expect(result.current.worktreeStatusCheck).toEqual({ state: 'error', error: 'status unavailable' }));
    expect(result.current.worktreeStatus).toBeNull();
    await waitFor(() => expect(result.current.worktreeDiffCheck).toEqual(checked));
    expect(result.current.worktreeDiff).toEqual(diffA);
  });

  it.each([
    [{ success: false, error: 'No worktree found for this task' }, 'No worktree found for this task'],
    [{ success: true }, 'Failed to load worktree status'],
  ] as const)('reports an error for status response %o', async (response, error) => {
    api.getWorktreeStatus.mockResolvedValue(response);
    const { result } = renderTask();

    await waitFor(() => expect(result.current.worktreeStatusCheck).toEqual({ state: 'error', error }));
    expect(result.current.worktreeStatus).toBeNull();
  });

  it('retries a failed diff without checking status again', async () => {
    api.getWorktreeDiff.mockResolvedValueOnce({ success: false, error: 'git diff failed' });
    const { result } = renderTask();

    await waitFor(() => expect(result.current.worktreeDiffCheck).toEqual({ state: 'error', error: 'git diff failed' }));
    expect(result.current.worktreeStatusCheck).toEqual(checked);
    expect(result.current.worktreeStatus).toEqual(statusA);

    await act(() => result.current.retryWorktreeDiff());
    expect(result.current.worktreeDiffCheck).toEqual(checked);
    expect(result.current.worktreeDiff).toEqual(diffA);
    expect(api.getWorktreeStatus).toHaveBeenCalledTimes(1);
  });

  it('retries a failed status check without fetching the diff again', async () => {
    api.getWorktreeStatus.mockRejectedValueOnce(new Error('lookup failed'));
    const { result } = renderTask();
    await waitFor(() => expect(result.current.worktreeStatusCheck.state).toBe('error'));

    await act(() => result.current.retryWorktreeStatus());
    expect(result.current.worktreeStatusCheck).toEqual(checked);
    expect(result.current.worktreeStatus).toEqual(statusA);
    expect(api.getWorktreeDiff).toHaveBeenCalledTimes(1);
  });

  it('ignores late status and diff responses for the previous task', async () => {
    const firstStatus = deferred<IPCResult<WorktreeStatus>>();
    const firstDiff = deferred<IPCResult<WorktreeDiff>>();
    const secondStatus = deferred<IPCResult<WorktreeStatus>>();
    const secondDiff = deferred<IPCResult<WorktreeDiff>>();
    api.getWorktreeStatus.mockReturnValueOnce(firstStatus.promise).mockReturnValueOnce(secondStatus.promise);
    api.getWorktreeDiff.mockReturnValueOnce(firstDiff.promise).mockReturnValueOnce(secondDiff.promise);
    const { result, rerender } = renderTask();

    rerender({ task: taskB });
    expect(api.getWorktreeStatus).toHaveBeenLastCalledWith(taskB.id);
    expect(api.getWorktreeDiff).toHaveBeenLastCalledWith(taskB.id);
    await act(async () => {
      secondStatus.resolve(success(statusB));
      secondDiff.resolve(success(diffB));
    });
    await act(async () => {
      firstStatus.resolve(success(statusA));
      firstDiff.resolve(success(diffA));
    });

    expect(result.current.worktreeStatusCheck).toEqual(checked);
    expect(result.current.worktreeStatus).toEqual(statusB);
    expect(result.current.worktreeDiffCheck).toEqual(checked);
    expect(result.current.worktreeDiff).toEqual(diffB);
  });

  it('clears verified data while checking a different task', async () => {
    const { result, rerender } = renderTask();
    await waitFor(() => expect(result.current.worktreeDiffCheck).toEqual(checked));
    expect(result.current.worktreeStatus).toEqual(statusA);
    expect(result.current.worktreeDiff).toEqual(diffA);

    const status = deferred<IPCResult<WorktreeStatus>>();
    const diff = deferred<IPCResult<WorktreeDiff>>();
    api.getWorktreeStatus.mockReturnValueOnce(status.promise);
    api.getWorktreeDiff.mockReturnValueOnce(diff.promise);
    rerender({ task: taskB });
    expect(result.current.worktreeStatus).toBeNull();
    expect(result.current.worktreeDiff).toBeNull();
    expect(result.current.isLoadingWorktree).toBe(true);
    expect(result.current.isLoadingWorktreeDiff).toBe(true);

    await act(async () => {
      status.resolve(success(statusB));
      diff.resolve(success(diffB));
    });
  });

  it('ignores an older diff retry that resolves after a newer one', async () => {
    const olderDiff = deferred<IPCResult<WorktreeDiff>>();
    const newerDiff = deferred<IPCResult<WorktreeDiff>>();
    const { result } = renderTask();
    await waitFor(() => expect(result.current.worktreeDiffCheck).toEqual(checked));
    api.getWorktreeDiff.mockReturnValueOnce(olderDiff.promise).mockReturnValueOnce(newerDiff.promise);

    act(() => {
      void result.current.retryWorktreeDiff();
      void result.current.retryWorktreeDiff();
    });
    expect(result.current.worktreeDiff).toEqual(diffA);
    expect(result.current.isLoadingWorktreeDiff).toBe(true);
    await act(async () => newerDiff.resolve(success(diffB)));
    await act(async () => olderDiff.resolve(success(diffA)));

    expect(result.current.worktreeDiffCheck).toEqual(checked);
    expect(result.current.worktreeDiff).toEqual(diffB);
  });

  it('keeps verified status if a merge-preview status refresh fails', async () => {
    const { result } = renderTask();
    await waitFor(() => expect(result.current.worktreeStatusCheck).toEqual(checked));
    api.getWorktreeStatus.mockRejectedValueOnce(new Error('refresh failed'));

    await act(() => result.current.loadMergePreview());
    expect(result.current.worktreeStatusCheck).toEqual(checked);
    expect(result.current.worktreeStatus).toEqual(statusA);
    expect(result.current.workspaceError).toBe('Worktree status: refresh failed');
  });

  it('records a status refresh error if merge preview has no verified status to keep', async () => {
    api.getWorktreeStatus.mockResolvedValue({ success: false, error: 'status lookup failed' });
    const { result } = renderTask();
    await waitFor(() => expect(result.current.worktreeStatusCheck.state).toBe('error'));

    await act(() => result.current.loadMergePreview());
    expect(result.current.worktreeStatusCheck).toEqual({ state: 'error', error: 'status lookup failed' });
    expect(result.current.worktreeStatus).toBeNull();
  });

  it('does not apply preview or status refresh results from a previous task', async () => {
    const preview = deferred<IPCResult<WorktreeMergeResult>>();
    const refresh = deferred<IPCResult<WorktreeStatus>>();
    const { result, rerender } = renderTask();
    await waitFor(() => expect(result.current.worktreeStatusCheck).toEqual(checked));
    api.mergeWorktreePreview.mockReturnValueOnce(preview.promise);
    api.getWorktreeStatus.mockReturnValueOnce(refresh.promise).mockResolvedValueOnce(success(statusB));
    act(() => { void result.current.loadMergePreview(); });
    expect(result.current.isLoadingPreview).toBe(true);

    rerender({ task: taskB });
    await waitFor(() => expect(result.current.worktreeStatus).toEqual(statusB));
    await act(async () => {
      preview.resolve(success({
        success: true,
        message: '',
        preview: {
          files: ['from-a.ts'],
          conflicts: [],
          summary: { totalFiles: 1, conflictFiles: 0, totalConflicts: 0, autoMergeable: 1 },
        },
      }));
      refresh.resolve(success(statusA));
    });

    expect(result.current.mergePreview).toBeNull();
    expect(result.current.workspaceError).toBeNull();
    expect(result.current.isLoadingPreview).toBe(false);
    expect(result.current.worktreeStatus).toEqual(statusB);
  });

  it('publishes the diff from Review Again even if status fails, keeping verified status data', async () => {
    const { result } = renderTask();
    await waitFor(() => expect(result.current.worktreeStatusCheck).toEqual(checked));
    api.getWorktreeStatus.mockRejectedValueOnce(new Error('status lookup failed'));
    api.getWorktreeDiff.mockResolvedValueOnce(success(diffB));

    await act(() => result.current.handleReviewAgain());
    expect(result.current.worktreeStatusCheck).toEqual({ state: 'error', error: 'status lookup failed' });
    expect(result.current.worktreeStatus).toEqual(statusA);
    expect(result.current.worktreeDiffCheck).toEqual(checked);
    expect(result.current.worktreeDiff).toEqual(diffB);
  });

  it('clears verified data and returns both checks to idle when the task leaves review', async () => {
    const { result, rerender } = renderTask();
    await waitFor(() => expect(result.current.worktreeDiffCheck).toEqual(checked));
    expect(result.current.worktreeStatus).toEqual(statusA);
    expect(result.current.worktreeDiff).toEqual(diffA);

    rerender({ task: { ...taskA, status: 'done' } });
    expect(result.current.worktreeStatus).toBeNull();
    expect(result.current.worktreeDiff).toBeNull();
    expect(result.current.worktreeStatusCheck).toEqual({ state: 'idle', error: null });
    expect(result.current.worktreeDiffCheck).toEqual({ state: 'idle', error: null });
  });
});
