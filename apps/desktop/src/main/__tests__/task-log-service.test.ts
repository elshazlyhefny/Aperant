/**
 * Tests for the stat-based TaskLogService poller.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const readFileSync = vi.fn(actual.readFileSync);
  return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

const findTaskWorktreeMock = vi.hoisted(() => vi.fn());
vi.mock('../worktree-paths', () => ({
  findTaskWorktree: findTaskWorktreeMock
}));

vi.mock('../../shared/utils/debug-logger', () => ({
  debugLog: vi.fn(),
  debugWarn: vi.fn(),
  debugError: vi.fn()
}));

import { TaskLogService } from '../task-log-service';

const SPEC_ID = '001-test';
const SPECS_REL = '.auto-claude/specs';

function makeLogs(entries: number): string {
  const list = Array.from({ length: entries }, (_, i) => ({
    timestamp: new Date(1000 + i).toISOString(),
    type: 'text',
    content: `entry ${i}`,
    phase: 'coding'
  }));
  return JSON.stringify({
    spec_id: SPEC_ID,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    phases: {
      planning: { phase: 'planning', status: 'pending', started_at: null, completed_at: null, entries: [] },
      coding: { phase: 'coding', status: 'active', started_at: null, completed_at: null, entries: list },
      validation: { phase: 'validation', status: 'pending', started_at: null, completed_at: null, entries: [] }
    }
  });
}

function writeLogs(file: string, entries: number, mtimeOffsetSec: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, makeLogs(entries));
  const t = new Date(Date.now() + mtimeOffsetSec * 1000);
  fs.utimesSync(file, t, t);
}

describe('TaskLogService stat-based polling', () => {
  let tmp: string;
  let specDir: string;
  let mainFile: string;
  let svc: TaskLogService;
  let changed: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-log-service-'));
    specDir = path.join(tmp, 'main', SPECS_REL, SPEC_ID);
    mainFile = path.join(specDir, 'task_logs.json');
    writeLogs(mainFile, 1, 0);
    findTaskWorktreeMock.mockReset();
    findTaskWorktreeMock.mockReturnValue(null);
    svc = new TaskLogService();
    changed = vi.fn();
    svc.on('logs-changed', changed);
  });

  afterEach(() => {
    svc.stopAllWatching();
    vi.useRealTimers();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('does not emit logs-changed on idle ticks', () => {
    svc.startWatching(SPEC_ID, specDir);
    vi.advanceTimersByTime(5000);
    expect(changed).not.toHaveBeenCalled();
  });

  it('emits once after the file is rewritten', () => {
    svc.startWatching(SPEC_ID, specDir);
    vi.advanceTimersByTime(2000);
    writeLogs(mainFile, 3, 10);
    vi.advanceTimersByTime(1000);
    expect(changed).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3000);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('detects a worktree file that appears later', () => {
    const projectPath = path.join(tmp, 'main');
    const worktree = path.join(tmp, 'worktree');
    svc.startWatching(SPEC_ID, specDir, projectPath, SPECS_REL);
    vi.advanceTimersByTime(2000);
    expect(changed).not.toHaveBeenCalled();

    findTaskWorktreeMock.mockReturnValue(worktree);
    writeLogs(path.join(worktree, SPECS_REL, SPEC_ID, 'task_logs.json'), 2, 5);
    vi.advanceTimersByTime(1000);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('does not read files on idle ticks', () => {
    svc.startWatching(SPEC_ID, specDir);
    const readSpy = fs.readFileSync as unknown as ReturnType<typeof vi.fn>;
    const before = readSpy.mock.calls.length;
    vi.advanceTimersByTime(10000);
    expect(readSpy.mock.calls.length).toBe(before);
  });

  it('stopWatching clears the interval', () => {
    svc.startWatching(SPEC_ID, specDir);
    expect(vi.getTimerCount()).toBe(1);
    svc.stopWatching(SPEC_ID);
    expect(vi.getTimerCount()).toBe(0);
    writeLogs(mainFile, 4, 20);
    vi.advanceTimersByTime(3000);
    expect(changed).not.toHaveBeenCalled();
  });
});
