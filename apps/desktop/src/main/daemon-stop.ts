/**
 * zeenha fork: stop a task that the `serve` daemon runs, from the desktop app.
 * The desktop process does not own the run, so it writes the same stop request
 * file that `cli.js stop` writes and the daemon applies it on its next poll.
 *
 * Electron-free on purpose. Do not use process.platform here.
 */

import { existsSync, unlinkSync } from 'fs';
import path from 'path';
import { findLiveDaemon, getStopRequestDir, writeStopRequest, type FindLiveDaemonOptions } from './headless/stop-request';
import { readServeRunningTaskIds } from './utils/serve-running-file';

export type DaemonStopError = 'not-running-on-daemon' | 'no-daemon' | 'invalid-task';

export type DaemonStopResult = { success: true } | { success: false; error: DaemonStopError; message?: string };

export type DaemonStopCheck = 'handled' | 'abandoned' | 'pending';

export type DaemonStopOptions = FindLiveDaemonOptions;

const TASK_ID_RE = /^[A-Za-z0-9._-]+$/;
const MAX_TASK_ID_LENGTH = 200;

function isValidTaskId(taskId: unknown): taskId is string {
  return (
    typeof taskId === 'string' &&
    taskId.length > 0 &&
    taskId.length <= MAX_TASK_ID_LENGTH &&
    TASK_ID_RE.test(taskId) &&
    taskId !== '.' &&
    taskId !== '..'
  );
}

/** Ask the live daemon to stop a task it runs (no requeue, like `cli.js stop`). */
export function requestDaemonStop(
  projectPath: string,
  taskId: string,
  opts: DaemonStopOptions = {}
): DaemonStopResult {
  if (!isValidTaskId(taskId)) return { success: false, error: 'invalid-task' };
  if (!readServeRunningTaskIds(projectPath).includes(taskId)) {
    return { success: false, error: 'not-running-on-daemon' };
  }
  const daemon = findLiveDaemon(projectPath, opts);
  if (!daemon.ok) return { success: false, error: 'no-daemon', message: daemon.message };
  try {
    writeStopRequest(projectPath, { specId: taskId, requeue: false });
  } catch {
    return { success: false, error: 'invalid-task' };
  }
  return { success: true };
}

/**
 * Follow up on a stop request: 'handled' once the task left in_progress,
 * 'abandoned' when it is still running but no live daemon remains (the leftover
 * request file is removed so a later daemon cannot apply it), else 'pending'.
 */
export function checkDaemonStop(
  projectPath: string,
  taskId: string,
  taskStatus: string,
  opts: DaemonStopOptions = {}
): DaemonStopCheck {
  if (taskStatus !== 'in_progress') return 'handled';
  if (findLiveDaemon(projectPath, opts).ok) return 'pending';
  if (isValidTaskId(taskId)) {
    const file = path.join(getStopRequestDir(projectPath), `stop-request-${taskId}.json`);
    try {
      if (existsSync(file)) unlinkSync(file);
    } catch {
      // best effort
    }
  }
  return 'abandoned';
}
