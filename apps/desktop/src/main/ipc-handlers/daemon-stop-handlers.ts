/**
 * zeenha fork: stop a task that the `serve` daemon runs, from its card.
 * Writes the same stop request as `cli.js stop`, then watches until the task
 * leaves in_progress (handled) or the daemon goes away without handling it.
 */

import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult } from '../../shared/types';
import type { DaemonStopResultEvent } from '../../shared/types/task-queue';
import { assertTrustedSender } from '../ipc-sender-validation';
import { checkDaemonStop, requestDaemonStop } from '../daemon-stop';
import { projectStore } from '../project-store';
import { findTaskAndProject } from './task/shared';
import { safeSendToRenderer } from './utils';

const POLL_INTERVAL_MS = 2000;
const WATCH_CEILING_MS = 3 * 60 * 1000;

interface Watcher {
  timer: ReturnType<typeof setInterval>;
}

const watchers = new Map<string, Watcher>();

/** Stop every pending watcher (tests and shutdown). */
export function clearDaemonStopWatchers(): void {
  for (const w of watchers.values()) clearInterval(w.timer);
  watchers.clear();
}

function watchDaemonStop(
  getMainWindow: () => BrowserWindow | null,
  projectId: string,
  projectPath: string,
  taskId: string,
  specId: string
): void {
  const key = `${projectId}:${taskId}`;
  if (watchers.has(key)) return;
  const startedAt = Date.now();

  const finish = (reason?: DaemonStopResultEvent['reason']): void => {
    const w = watchers.get(key);
    if (w) clearInterval(w.timer);
    watchers.delete(key);
    if (reason) {
      const event: DaemonStopResultEvent = { taskId, projectId, state: 'failed', reason };
      safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_DAEMON_STOP_RESULT, event);
    }
  };

  const timer = setInterval(() => {
    try {
      const task = projectStore.getTasks(projectId).find((t) => t.id === taskId || t.specId === taskId);
      const status = task?.status ?? 'done';
      const check = checkDaemonStop(projectPath, specId, status);
      if (check === 'handled') return finish();
      if (check === 'abandoned') return finish('daemon-released');
      if (Date.now() - startedAt >= WATCH_CEILING_MS) finish('timeout');
    } catch {
      if (Date.now() - startedAt >= WATCH_CEILING_MS) finish('timeout');
    }
  }, POLL_INTERVAL_MS);
  timer.unref?.();
  watchers.set(key, { timer });
}

export function registerDaemonStopHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle(
    IPC_CHANNELS.TASK_DAEMON_STOP,
    async (event, taskId: unknown): Promise<IPCResult> => {
      if (!assertTrustedSender(event, IPC_CHANNELS.TASK_DAEMON_STOP)) {
        return { success: false, error: 'Untrusted sender' };
      }
      if (typeof taskId !== 'string' || taskId.length === 0) {
        return { success: false, error: 'Invalid task id' };
      }
      const { task, project } = findTaskAndProject(taskId);
      if (!task || !project) return { success: false, error: 'Task not found' };
      if (task.status !== 'in_progress') return { success: false, error: 'Task is not running' };

      const result = requestDaemonStop(project.path, task.specId);
      if (!result.success) return { success: false, error: result.error };

      watchDaemonStop(getMainWindow, project.id, project.path, task.id, task.specId);
      return { success: true };
    }
  );
}
