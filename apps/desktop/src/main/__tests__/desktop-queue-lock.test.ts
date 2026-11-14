import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log-port', () => ({
  appLogPort: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}));

import { appLogPort } from '../log-port';
import { ensureQueueLock, releaseAllQueueLocks } from '../desktop-queue-lock';
import { acquireProjectQueueLock, readLockHolder } from '../utils/project-queue-lock';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'dql-'));
  dirs.push(d);
  return d;
};

afterEach(() => {
  releaseAllQueueLocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('desktop-queue-lock', () => {
  it('holds one lock per project and releases it', () => {
    const dir = tmp();
    expect(ensureQueueLock({ path: dir })).toEqual({ ok: true });
    expect(ensureQueueLock({ path: dir })).toEqual({ ok: true });
    expect(readLockHolder(dir)?.kind).toBe('desktop');
    releaseAllQueueLocks();
    expect(readLockHolder(dir)).toBeNull();
  });

  it('reports the daemon holder and warns once', () => {
    const dir = tmp();
    const daemon = acquireProjectQueueLock(dir, 'daemon');
    expect(daemon.ok).toBe(true);
    const first = ensureQueueLock({ path: dir });
    ensureQueueLock({ path: dir });
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.holder?.kind).toBe('daemon');
    expect(appLogPort.warn).toHaveBeenCalledTimes(1);
    if (daemon.ok) daemon.lock.release();
  });
});
