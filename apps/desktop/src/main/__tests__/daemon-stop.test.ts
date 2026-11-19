import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkDaemonStop, requestDaemonStop } from '../daemon-stop';
import { getStopRequestDir } from '../headless/stop-request';
import { getQueueLockPath } from '../utils/project-queue-lock';
import { getServeRunningPath } from '../utils/serve-running-file';

const dirs: string[] = [];
const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const HOST = 'test-host';

const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'dstop-'));
  dirs.push(d);
  return d;
};

function setLock(dir: string, kind: 'daemon' | 'desktop', heartbeatAgoMs = 0, pid = 4242) {
  const file = getQueueLockPath(dir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      token: 't',
      kind,
      pid,
      host: HOST,
      startedAt: new Date(NOW - 1000).toISOString(),
      heartbeatAt: new Date(NOW - heartbeatAgoMs).toISOString()
    })
  );
}

function setRunning(dir: string, ids: string[]) {
  const file = getServeRunningPath(dir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ taskIds: ids }));
}

const live = { now: () => NOW, isPidAlive: () => true, hostname: HOST };
const dead = { now: () => NOW, isPidAlive: () => false, hostname: HOST };
const reqFile = (dir: string, id: string) => path.join(getStopRequestDir(dir), `stop-request-${id}.json`);

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('requestDaemonStop', () => {
  it('writes the stop request for a task the live daemon runs', () => {
    const dir = tmp();
    setLock(dir, 'daemon');
    setRunning(dir, ['001-a']);
    expect(requestDaemonStop(dir, '001-a', live)).toEqual({ success: true });
    const data = JSON.parse(readFileSync(reqFile(dir, '001-a'), 'utf-8'));
    expect(data.specId).toBe('001-a');
    expect(data.requeue).toBe(false);
    expect(typeof data.requestedAt).toBe('string');
  });

  it('rejects a task not listed in serve-running.json', () => {
    const dir = tmp();
    setLock(dir, 'daemon');
    setRunning(dir, ['001-a']);
    expect(requestDaemonStop(dir, '002-b', live)).toEqual({ success: false, error: 'not-running-on-daemon' });
    expect(existsSync(reqFile(dir, '002-b'))).toBe(false);
  });

  it('rejects when the lock is held by the desktop app', () => {
    const dir = tmp();
    setLock(dir, 'desktop');
    setRunning(dir, ['001-a']);
    const res = requestDaemonStop(dir, '001-a', live);
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error).toBe('no-daemon');
    expect(existsSync(reqFile(dir, '001-a'))).toBe(false);
  });

  it('rejects when the daemon lock is stale (dead pid or old heartbeat)', () => {
    const dir = tmp();
    setLock(dir, 'daemon');
    setRunning(dir, ['001-a']);
    const a = requestDaemonStop(dir, '001-a', dead);
    expect(a.success).toBe(false);
    setLock(dir, 'daemon', 10 * 60_000);
    const b = requestDaemonStop(dir, '001-a', live);
    expect(b.success).toBe(false);
    if (!b.success) {
      expect(b.error).toBe('no-daemon');
      expect(b.message).toContain('stale');
    }
  });

  it('rejects when there is no lock at all', () => {
    const dir = tmp();
    setRunning(dir, ['001-a']);
    const res = requestDaemonStop(dir, '001-a', live);
    expect(res).toMatchObject({ success: false, error: 'no-daemon' });
  });

  it('rejects an invalid task id', () => {
    const dir = tmp();
    setLock(dir, 'daemon');
    setRunning(dir, ['../x']);
    expect(requestDaemonStop(dir, '../x', live)).toEqual({ success: false, error: 'invalid-task' });
    expect(requestDaemonStop(dir, '', live)).toEqual({ success: false, error: 'invalid-task' });
  });
});

describe('checkDaemonStop', () => {
  it('is handled once the task is no longer in_progress', () => {
    const dir = tmp();
    expect(checkDaemonStop(dir, '001-a', 'backlog', live)).toBe('handled');
  });

  it('is pending while in_progress with a live daemon', () => {
    const dir = tmp();
    setLock(dir, 'daemon');
    expect(checkDaemonStop(dir, '001-a', 'in_progress', live)).toBe('pending');
  });

  it('is abandoned and removes the leftover request when the daemon is gone', () => {
    const dir = tmp();
    setLock(dir, 'daemon');
    setRunning(dir, ['001-a']);
    requestDaemonStop(dir, '001-a', live);
    expect(existsSync(reqFile(dir, '001-a'))).toBe(true);
    expect(checkDaemonStop(dir, '001-a', 'in_progress', dead)).toBe('abandoned');
    expect(existsSync(reqFile(dir, '001-a'))).toBe(false);
  });

  it('is abandoned without a leftover file and with no lock', () => {
    const dir = tmp();
    expect(checkDaemonStop(dir, '001-a', 'in_progress', live)).toBe('abandoned');
  });

  it('does not touch files for an invalid task id', () => {
    const dir = tmp();
    expect(checkDaemonStop(dir, '../x', 'in_progress', live)).toBe('abandoned');
  });
});
