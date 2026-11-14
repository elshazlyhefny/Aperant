import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireProjectQueueLock,
  formatLockHolder,
  getQueueLockPath,
  readLockHolder
} from '../project-queue-lock';

describe('project-queue-lock', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'queue-lock-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('acquires and releases', () => {
    const r = acquireProjectQueueLock(dir, 'desktop');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(existsSync(getQueueLockPath(dir))).toBe(true);
    r.lock.release();
    expect(existsSync(getQueueLockPath(dir))).toBe(false);
  });

  it('reports the holder on a second acquire', () => {
    const a = acquireProjectQueueLock(dir, 'desktop');
    const b = acquireProjectQueueLock(dir, 'daemon');
    expect(b.ok).toBe(false);
    if (b.ok) return;
    expect(b.holder?.kind).toBe('desktop');
    expect(b.holder?.pid).toBe(process.pid);
    expect(formatLockHolder(b.holder)).toContain('desktop app (pid');
    if (a.ok) a.lock.release();
  });

  it('takes over a lock whose pid is dead', () => {
    acquireProjectQueueLock(dir, 'daemon');
    const r = acquireProjectQueueLock(dir, 'desktop', { isPidAlive: () => false });
    expect(r.ok).toBe(true);
    expect(readLockHolder(dir)?.kind).toBe('desktop');
  });

  it('takes over a lock with a stale heartbeat', () => {
    acquireProjectQueueLock(dir, 'daemon', { hostname: 'other' });
    const later = Date.now() + 3 * 60_000;
    const r = acquireProjectQueueLock(dir, 'desktop', { now: () => later });
    expect(r.ok).toBe(true);
  });

  it('does not take over a fresh lock from another host', () => {
    acquireProjectQueueLock(dir, 'daemon', { hostname: 'other' });
    const r = acquireProjectQueueLock(dir, 'desktop', { isPidAlive: () => false });
    expect(r.ok).toBe(false);
  });

  it('treats a fresh corrupt file as held', () => {
    acquireProjectQueueLock(dir, 'daemon');
    writeFileSync(getQueueLockPath(dir), 'not json');
    expect(acquireProjectQueueLock(dir, 'desktop').ok).toBe(false);
    const later = Date.now() + 3 * 60_000;
    expect(acquireProjectQueueLock(dir, 'desktop', { now: () => later }).ok).toBe(true);
  });

  it('release does not delete a lock taken over by another token', () => {
    const a = acquireProjectQueueLock(dir, 'daemon');
    if (!a.ok) throw new Error('expected lock');
    const b = acquireProjectQueueLock(dir, 'desktop', { isPidAlive: () => false });
    expect(b.ok).toBe(true);
    a.lock.release();
    expect(existsSync(getQueueLockPath(dir))).toBe(true);
    expect(JSON.parse(readFileSync(getQueueLockPath(dir), 'utf-8')).kind).toBe('desktop');
  });

  it('yields exactly one winner for concurrent acquires', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, async () => acquireProjectQueueLock(dir, 'desktop'))
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });
});
