/**
 * zeenha fork: the desktop app's side of the per-project queue lock. It holds at
 * most one lock per project path for the life of the app, so a headless daemon
 * cannot run the same queue at the same time. Desktop-only: it logs through
 * log-port and is never imported by the daemon.
 */
import {
  acquireProjectQueueLock,
  formatLockHolder,
  type ProjectQueueLock,
  type QueueLockHolder,
} from './utils/project-queue-lock';
import { appLogPort } from './log-port';

export type EnsureQueueLockResult = { ok: true } | { ok: false; holder: QueueLockHolder | null };

const held = new Map<string, ProjectQueueLock>();
const warned = new Set<string>();

/** Acquires (once) the queue lock for a project. Safe to call repeatedly. */
export function ensureQueueLock(project: { path: string }): EnsureQueueLockResult {
  if (held.has(project.path)) return { ok: true };
  try {
    const result = acquireProjectQueueLock(project.path, 'desktop');
    if (result.ok) {
      result.lock.startHeartbeat();
      held.set(project.path, result.lock);
      warned.delete(project.path);
      return { ok: true };
    }
    if (!warned.has(project.path)) {
      warned.add(project.path);
      appLogPort.warn(
        `[Queue] ${project.path} is run by the ${formatLockHolder(result.holder)}; the desktop queue and schedules are paused for it`
      );
    }
    return { ok: false, holder: result.holder };
  } catch (error) {
    // A lock directory we cannot write must not take the whole queue down
    appLogPort.error(`[Queue] Could not take the queue lock for ${project.path}:`, error);
    return { ok: true };
  }
}

export function releaseAllQueueLocks(): void {
  for (const lock of held.values()) lock.release();
  held.clear();
  warned.clear();
}
