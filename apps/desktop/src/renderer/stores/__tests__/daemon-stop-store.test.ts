import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDaemonStopStore } from '../daemon-stop-store';

const stopFn = vi.fn();

describe('daemon-stop-store', () => {
  beforeEach(() => {
    useDaemonStopStore.setState({ pendingByTask: {}, errorByTask: {} });
    stopFn.mockReset();
    (globalThis as Record<string, unknown>).window = { electronAPI: { daemonStopTask: stopFn } };
  });

  it('marks pending after a successful request and clear drops it', async () => {
    stopFn.mockResolvedValue({ success: true });
    await useDaemonStopStore.getState().requestStop('t1');
    expect(useDaemonStopStore.getState().pendingByTask.t1).toBe(true);
    useDaemonStopStore.getState().clear('t1');
    expect(useDaemonStopStore.getState().pendingByTask.t1).toBeUndefined();
  });

  it('stores the error code when the IPC result fails', async () => {
    stopFn.mockResolvedValue({ success: false, error: 'no-daemon' });
    await useDaemonStopStore.getState().requestStop('t1');
    expect(useDaemonStopStore.getState().pendingByTask.t1).toBeUndefined();
    expect(useDaemonStopStore.getState().errorByTask.t1).toBe('no-daemon');
  });

  it('setFailed from an event clears pending and stores the reason', async () => {
    stopFn.mockResolvedValue({ success: true });
    await useDaemonStopStore.getState().requestStop('t1');
    useDaemonStopStore.getState().setFailed('t1', 'timeout');
    expect(useDaemonStopStore.getState().pendingByTask.t1).toBeUndefined();
    expect(useDaemonStopStore.getState().errorByTask.t1).toBe('timeout');
  });

  it('clears an old error on a new request', async () => {
    useDaemonStopStore.getState().setFailed('t1', 'timeout');
    stopFn.mockResolvedValue({ success: true });
    await useDaemonStopStore.getState().requestStop('t1');
    expect(useDaemonStopStore.getState().errorByTask.t1).toBeUndefined();
  });

  it('ignores a repeated click while pending', async () => {
    stopFn.mockResolvedValue({ success: true });
    await useDaemonStopStore.getState().requestStop('t1');
    await useDaemonStopStore.getState().requestStop('t1');
    expect(stopFn).toHaveBeenCalledTimes(1);
  });
});
