import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const toolkit = vi.hoisted(() => ({ is: { dev: true } }));
vi.mock('@electron-toolkit/utils', () => toolkit);

const stop = vi.hoisted(() => ({
  requestDaemonStop: vi.fn(),
  checkDaemonStop: vi.fn(),
}));
vi.mock('../daemon-stop', () => stop);

const store = vi.hoisted(() => ({
  find: vi.fn(),
  getTasks: vi.fn(),
}));
vi.mock('../ipc-handlers/task/shared', () => ({ findTaskAndProject: store.find }));
vi.mock('../project-store', () => ({ projectStore: { getTasks: store.getTasks } }));

const send = vi.hoisted(() => vi.fn());
vi.mock('../ipc-handlers/utils', () => ({ safeSendToRenderer: send }));

import { ipcMain } from 'electron';
import { registerDaemonStopHandlers, clearDaemonStopWatchers } from '../ipc-handlers/daemon-stop-handlers';
import { IPC_CHANNELS } from '../../shared/constants';

const DEV_URL = 'http://localhost:5173';
const trusted = { senderFrame: { url: DEV_URL } };
const task = { id: 't1', specId: '001-t1', status: 'in_progress' };
const project = { id: 'p1', path: '/proj' };

type Res = { success: boolean; error?: string };
let registered = false;
function call(event: unknown, taskId: unknown) {
  if (!registered) {
    registerDaemonStopHandlers((() => null) as never);
    registered = true;
  }
  const mock = ipcMain as never as { invokeHandler: (c: string, ...a: unknown[]) => Promise<Res> };
  return mock.invokeHandler(IPC_CHANNELS.TASK_DAEMON_STOP, event, taskId);
}

describe('TASK_DAEMON_STOP handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    toolkit.is.dev = true;
    process.env['ELECTRON_RENDERER_URL'] = DEV_URL;
    store.find.mockReturnValue({ task, project });
    store.getTasks.mockReturnValue([task]);
    stop.requestDaemonStop.mockReturnValue({ success: true });
    stop.checkDaemonStop.mockReturnValue('pending');
  });
  afterEach(() => {
    clearDaemonStopWatchers();
    vi.useRealTimers();
  });

  it('rejects untrusted senders without writing a request', async () => {
    const res = await call({ senderFrame: { url: 'https://evil.example.com' } }, 't1');
    expect(res).toEqual({ success: false, error: 'Untrusted sender' });
    expect(stop.requestDaemonStop).not.toHaveBeenCalled();
  });

  it('rejects a non-string task id', async () => {
    const res = await call(trusted, 42);
    expect(res.success).toBe(false);
    expect(stop.requestDaemonStop).not.toHaveBeenCalled();
  });

  it('rejects unknown tasks', async () => {
    store.find.mockReturnValue({ task: undefined, project: undefined });
    const res = await call(trusted, 'nope');
    expect(res).toEqual({ success: false, error: 'Task not found' });
    expect(stop.requestDaemonStop).not.toHaveBeenCalled();
  });

  it('rejects tasks that are not in_progress', async () => {
    store.find.mockReturnValue({ task: { ...task, status: 'done' }, project });
    const res = await call(trusted, 't1');
    expect(res.success).toBe(false);
    expect(stop.requestDaemonStop).not.toHaveBeenCalled();
  });

  it('returns the error code when the task is not on the daemon', async () => {
    stop.requestDaemonStop.mockReturnValue({ success: false, error: 'not-running-on-daemon' });
    const res = await call(trusted, 't1');
    expect(res).toEqual({ success: false, error: 'not-running-on-daemon' });
    vi.advanceTimersByTime(10_000);
    expect(stop.checkDaemonStop).not.toHaveBeenCalled();
  });

  it('writes the request using the store path and spec id', async () => {
    const res = await call(trusted, 't1');
    expect(res).toEqual({ success: true });
    expect(stop.requestDaemonStop).toHaveBeenCalledWith('/proj', '001-t1');
  });

  it('emits failed when the lock goes away and the task is still in_progress', async () => {
    await call(trusted, 't1');
    stop.checkDaemonStop.mockReturnValue('abandoned');
    vi.advanceTimersByTime(2100);
    expect(send).toHaveBeenCalledWith(expect.any(Function), IPC_CHANNELS.TASK_DAEMON_STOP_RESULT, {
      taskId: 't1',
      projectId: 'p1',
      state: 'failed',
      reason: 'daemon-released',
    });
    send.mockClear();
    vi.advanceTimersByTime(10_000);
    expect(send).not.toHaveBeenCalled();
  });

  it('stops silently when the status changes', async () => {
    await call(trusted, 't1');
    stop.checkDaemonStop.mockReturnValue('handled');
    vi.advanceTimersByTime(2100);
    vi.advanceTimersByTime(10_000);
    expect(send).not.toHaveBeenCalled();
    expect(stop.checkDaemonStop).toHaveBeenCalledTimes(1);
  });

  it('times out after the ceiling', async () => {
    await call(trusted, 't1');
    vi.advanceTimersByTime(3 * 60 * 1000 + 4000);
    expect(send).toHaveBeenCalledWith(
      expect.any(Function),
      IPC_CHANNELS.TASK_DAEMON_STOP_RESULT,
      expect.objectContaining({ reason: 'timeout' })
    );
  });

  it('does not create a second watcher on a repeated click', async () => {
    await call(trusted, 't1');
    await call(trusted, 't1');
    vi.advanceTimersByTime(2100);
    expect(stop.checkDaemonStop).toHaveBeenCalledTimes(1);
  });
});
