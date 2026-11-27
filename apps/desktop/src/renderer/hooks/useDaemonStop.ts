import { useCallback, useEffect } from 'react';
import type { Task } from '../../shared/types';
import { useDaemonStopStore } from '../stores/daemon-stop-store';
import { useTaskQueueStore } from '../stores/task-queue-store';

/**
 * zeenha fork: stop state for a task card. lockedTaskIds is only set while the
 * daemon holds the project lock, so a desktop-run task is never a daemon run.
 *
 * User docs: guides/CLI-USAGE.md, "Using the desktop app while serve runs". Update it when this behaviour changes.
 */
export function useDaemonStop(task: Pick<Task, 'id' | 'projectId' | 'status'>) {
  const inProgress = task.status === 'in_progress';
  const locked = useTaskQueueStore((s) => s.statesByProject[task.projectId]?.lockedTaskIds);
  const pending = useDaemonStopStore((s) => Boolean(s.pendingByTask[task.id]));
  const error = useDaemonStopStore((s) => s.errorByTask[task.id]);
  const requestStop = useDaemonStopStore((s) => s.requestStop);
  const clear = useDaemonStopStore((s) => s.clear);

  const isDaemonRun = inProgress && Boolean(locked?.includes(task.id));

  // A status change away from in_progress is the daemon's confirmation
  useEffect(() => {
    if (!inProgress && (pending || error)) clear(task.id);
  }, [inProgress, pending, error, task.id, clear]);

  const stop = useCallback(() => requestStop(task.id), [requestStop, task.id]);

  return { isDaemonRun, isPending: pending && inProgress, error, stop };
}
