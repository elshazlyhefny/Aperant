/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDaemonStop } from '../useDaemonStop';
import { useDaemonStopStore } from '../../stores/daemon-stop-store';
import { useTaskQueueStore } from '../../stores/task-queue-store';

const queue = (lockedTaskIds?: string[]) => ({
  projectId: 'p1',
  maxParallelTasks: 3,
  inProgressCount: 1,
  queuedTaskIds: [],
  skippedTaskIds: [],
  ...(lockedTaskIds ? { lockedBy: 'daemon', lockedTaskIds } : {}),
});

describe('useDaemonStop', () => {
  beforeEach(() => {
    useTaskQueueStore.setState({ statesByProject: {} });
    useDaemonStopStore.setState({ pendingByTask: {}, errorByTask: {} });
  });

  it('is a daemon run when locked ids include the in-progress task', () => {
    useTaskQueueStore.setState({ statesByProject: { p1: queue(['t1']) } });
    const { result } = renderHook(() => useDaemonStop({ id: 't1', projectId: 'p1', status: 'in_progress' }));
    expect(result.current.isDaemonRun).toBe(true);
  });

  it('is not a daemon run without lockedTaskIds', () => {
    useTaskQueueStore.setState({ statesByProject: { p1: queue() } });
    const { result } = renderHook(() => useDaemonStop({ id: 't1', projectId: 'p1', status: 'in_progress' }));
    expect(result.current.isDaemonRun).toBe(false);
  });

  it('is not a daemon run when the task is not in the list', () => {
    useTaskQueueStore.setState({ statesByProject: { p1: queue(['other']) } });
    const { result } = renderHook(() => useDaemonStop({ id: 't1', projectId: 'p1', status: 'in_progress' }));
    expect(result.current.isDaemonRun).toBe(false);
  });

  it('is not a daemon run when status is not in_progress', () => {
    useTaskQueueStore.setState({ statesByProject: { p1: queue(['t1']) } });
    const { result } = renderHook(() => useDaemonStop({ id: 't1', projectId: 'p1', status: 'backlog' }));
    expect(result.current.isDaemonRun).toBe(false);
  });

  it('drops pending when the status leaves in_progress', () => {
    useTaskQueueStore.setState({ statesByProject: { p1: queue(['t1']) } });
    useDaemonStopStore.setState({ pendingByTask: { t1: true } });
    const { result, rerender } = renderHook(
      ({ status }) => useDaemonStop({ id: 't1', projectId: 'p1', status } as never),
      { initialProps: { status: 'in_progress' } },
    );
    expect(result.current.isPending).toBe(true);
    act(() => rerender({ status: 'backlog' }));
    expect(result.current.isPending).toBe(false);
    expect(useDaemonStopStore.getState().pendingByTask.t1).toBeUndefined();
  });
});
