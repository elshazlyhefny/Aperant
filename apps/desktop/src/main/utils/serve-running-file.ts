/**
 * zeenha fork: the file the headless daemon (`cli.js serve`) writes with the ids
 * of the tasks it is running. The daemon uses it for crash recovery and the
 * desktop app reads it to show which tasks the daemon runs.
 *
 * Electron-free on purpose: the daemon imports it too. Do not use
 * process.platform here.
 */

import { readFileSync } from 'fs';
import path from 'path';

export const SERVE_RUNNING_FILE = 'serve-running.json';

/** Same directory as the queue lock (see getQueueLockPath). */
export function getServeRunningPath(projectPath: string): string {
  return path.join(projectPath, '.auto-claude', '.locks', SERVE_RUNNING_FILE);
}

/** Task ids the daemon reports running; [] when the file is missing or unreadable. */
export function readServeRunningTaskIds(projectPath: string): string[] {
  try {
    const data = JSON.parse(readFileSync(getServeRunningPath(projectPath), 'utf-8')) as { taskIds?: unknown };
    return Array.isArray(data.taskIds) ? data.taskIds.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
