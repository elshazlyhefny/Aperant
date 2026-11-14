/**
 * Project Queue Lock
 *
 * zeenha fork: the desktop app and the headless daemon can both run a
 * project's task queue. This lock makes sure only one of them does at a time.
 * It lives at `<project>/.auto-claude/.locks/queue-runner.lock` and is created
 * with the exclusive `wx` flag (same approach as spec-number-lock.ts).
 *
 * Electron-free on purpose: the daemon imports it too. Do not use
 * process.platform here.
 */

import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs';
import { hostname as osHostname } from 'os';
import path from 'path';
import { randomBytes } from 'crypto';

export type QueueLockKind = 'desktop' | 'daemon';

export interface QueueLockHolder {
  token: string;
  kind: QueueLockKind;
  pid: number;
  host: string;
  startedAt: string;
  heartbeatAt: string;
  version?: string;
}

export interface QueueLockOptions {
  now?: () => number;
  hostname?: string;
  isPidAlive?: (pid: number) => boolean;
  heartbeatMs?: number;
  staleMs?: number;
  version?: string;
}

export interface ProjectQueueLock {
  readonly holder: QueueLockHolder;
  release(): void;
  startHeartbeat(): void;
  stopHeartbeat(): void;
}

export type AcquireResult =
  | { ok: true; lock: ProjectQueueLock }
  | { ok: false; holder: QueueLockHolder | null };

const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_STALE_MS = 2 * 60_000;

export function getQueueLockPath(projectPath: string): string {
  return path.join(projectPath, '.auto-claude', '.locks', 'queue-runner.lock');
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // EPERM means the process exists but belongs to someone else
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseHolder(raw: string): QueueLockHolder | null {
  try {
    const data = JSON.parse(raw) as Partial<QueueLockHolder>;
    if (
      data &&
      typeof data.token === 'string' &&
      (data.kind === 'desktop' || data.kind === 'daemon') &&
      typeof data.pid === 'number' &&
      typeof data.host === 'string' &&
      typeof data.startedAt === 'string' &&
      typeof data.heartbeatAt === 'string'
    ) {
      return data as QueueLockHolder;
    }
  } catch {
    // corrupt
  }
  return null;
}

/** Read the current lock holder, or null when there is no (readable) lock. */
export function readLockHolder(projectPath: string): QueueLockHolder | null {
  try {
    return parseHolder(readFileSync(getQueueLockPath(projectPath), 'utf-8'));
  } catch {
    return null;
  }
}

/** Human sentence for error messages. */
export function formatLockHolder(holder: QueueLockHolder | null): string {
  if (!holder) return 'another process';
  const who = holder.kind === 'desktop' ? 'desktop app' : 'daemon';
  return `${who} (pid ${holder.pid} on host ${holder.host}, since ${holder.startedAt})`;
}

export function acquireProjectQueueLock(
  projectPath: string,
  kind: QueueLockKind,
  opts: QueueLockOptions = {}
): AcquireResult {
  const now = opts.now ?? Date.now;
  const host = opts.hostname ?? osHostname();
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const lockPath = getQueueLockPath(projectPath);

  mkdirSync(path.dirname(lockPath), { recursive: true });

  const iso = () => new Date(now()).toISOString();
  const holder: QueueLockHolder = {
    token: randomBytes(16).toString('hex'),
    kind,
    pid: process.pid,
    host,
    startedAt: iso(),
    heartbeatAt: iso(),
    ...(opts.version ? { version: opts.version } : {})
  };

  const isStale = (existing: QueueLockHolder | null): boolean => {
    if (!existing) {
      // Corrupt file: only stale once it has sat there longer than staleMs
      try {
        return now() - statSync(lockPath).mtimeMs > staleMs;
      } catch {
        return false;
      }
    }
    if (existing.host === host && !isPidAlive(existing.pid)) return true;
    const beat = Date.parse(existing.heartbeatAt);
    return Number.isNaN(beat) || now() - beat > staleMs;
  };

  const tryCreate = (): boolean => {
    try {
      writeFileSync(lockPath, JSON.stringify(holder), { flag: 'wx' });
      return true;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  };

  const makeLock = (): ProjectQueueLock => {
    let timer: NodeJS.Timeout | null = null;
    const ownsFile = () => readLockHolder(projectPath)?.token === holder.token;
    const lock: ProjectQueueLock = {
      holder,
      stopHeartbeat() {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
      },
      startHeartbeat() {
        if (timer) return;
        timer = setInterval(() => {
          try {
            if (!ownsFile()) return;
            holder.heartbeatAt = iso();
            const tmp = `${lockPath}.${holder.token}.tmp`;
            writeFileSync(tmp, JSON.stringify(holder));
            renameSync(tmp, lockPath);
          } catch {
            // Best effort; a missed beat is tolerated until staleMs
          }
        }, heartbeatMs);
        timer.unref();
      },
      release() {
        lock.stopHeartbeat();
        try {
          if (ownsFile()) unlinkSync(lockPath);
        } catch {
          // Best effort cleanup
        }
      }
    };
    return lock;
  };

  if (tryCreate()) return { ok: true, lock: makeLock() };

  const existing = readLockHolder(projectPath);
  if (isStale(existing)) {
    // Only remove the file we judged stale, not a fresh lock that replaced it
    const current = readLockHolder(projectPath);
    if ((current?.token ?? null) === (existing?.token ?? null)) {
      try {
        unlinkSync(lockPath);
      } catch {
        // someone else removed it
      }
    }
    if (tryCreate()) return { ok: true, lock: makeLock() };
    return { ok: false, holder: readLockHolder(projectPath) };
  }

  return { ok: false, holder: existing };
}
