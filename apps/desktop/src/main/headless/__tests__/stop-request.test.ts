import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireProjectQueueLock } from '../../utils/project-queue-lock';
import {
  consumeStopRequests,
  findLiveDaemon,
  getStopRequestDir,
  writeStopRequest
} from '../stop-request';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'headless-stop-request-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('write/consume', () => {
  it('round trips requeue true and false and removes the files', () => {
    const a = writeStopRequest(root, { specId: '001-a', requeue: true });
    const b = writeStopRequest(root, { specId: '002-b', requeue: false });
    expect(path.dirname(a)).toBe(getStopRequestDir(root));
    const out = consumeStopRequests(root).sort((x, y) => x.specId.localeCompare(y.specId));
    expect(out).toEqual([
      { specId: '001-a', requeue: true },
      { specId: '002-b', requeue: false }
    ]);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    expect(consumeStopRequests(root)).toEqual([]);
  });

  it('rejects invalid spec ids on write', () => {
    for (const id of ['', '.', '..', '../x', 'a/b', 'a\\b', 'a b']) {
      expect(() => writeStopRequest(root, { specId: id, requeue: false })).toThrow();
    }
  });

  it('removes and ignores invalid, corrupt and badly named files', () => {
    const dir = getStopRequestDir(root);
    mkdirSync(dir, { recursive: true });
    const corrupt = path.join(dir, 'stop-request-bad.json');
    const badId = path.join(dir, 'stop-request-x.json');
    const badName = path.join(dir, 'stop-request-a b.json');
    const long = path.join(dir, `stop-request-${'a'.repeat(210)}.json`);
    writeFileSync(corrupt, '{nope');
    writeFileSync(badId, JSON.stringify({ specId: '../evil', requeue: true }));
    writeFileSync(badName, JSON.stringify({ specId: 'ok', requeue: true }));
    writeFileSync(long, JSON.stringify({ specId: 'ok', requeue: true }));
    expect(consumeStopRequests(root)).toEqual([]);
    for (const f of [corrupt, badId, badName, long]) expect(existsSync(f)).toBe(false);
  });

  it('does not read a symlink pointing outside the folder', () => {
    const dir = getStopRequestDir(root);
    mkdirSync(dir, { recursive: true });
    const target = path.join(root, 'outside.json');
    const content = JSON.stringify({ specId: '001-a', requeue: true });
    writeFileSync(target, content);
    symlinkSync(target, path.join(dir, 'stop-request-link.json'));
    expect(consumeStopRequests(root)).toEqual([]);
    expect(readFileSync(target, 'utf-8')).toBe(content);
  });
});

describe('findLiveDaemon', () => {
  const now = () => Date.parse('2026-01-01T00:00:00Z');

  it('reports no lock', () => {
    const r = findLiveDaemon(root);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('No serve daemon is running for this project');
  });

  it('reports a desktop holder', () => {
    acquireProjectQueueLock(root, 'desktop', { now, hostname: 'h', isPidAlive: () => true });
    const r = findLiveDaemon(root, { now, hostname: 'h', isPidAlive: () => true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('held by the desktop app');
  });

  it('accepts a live daemon', () => {
    acquireProjectQueueLock(root, 'daemon', { now, hostname: 'h', isPidAlive: () => true });
    const r = findLiveDaemon(root, { now, hostname: 'h', isPidAlive: () => true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.holder.kind).toBe('daemon');
  });

  it('rejects a stale daemon lock (dead pid or old heartbeat)', () => {
    acquireProjectQueueLock(root, 'daemon', { now, hostname: 'h', isPidAlive: () => true });
    const dead = findLiveDaemon(root, { now, hostname: 'h', isPidAlive: () => false });
    expect(dead.ok).toBe(false);
    if (!dead.ok) expect(dead.message).toContain('stale');
    const old = findLiveDaemon(root, {
      now: () => now() + 10 * 60_000,
      hostname: 'other',
      isPidAlive: () => true
    });
    expect(old.ok).toBe(false);
    if (!old.ok) expect(old.message).toContain('stale');
  });
});
