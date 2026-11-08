import { describe, expect, it, vi } from 'vitest';

import { waitForHostLoad } from '../host-load';

const sleep = vi.fn(async () => undefined);

describe('waitForHostLoad', () => {
  it('returns at once when the machine is quiet', async () => {
    sleep.mockClear();
    expect(await waitForHostLoad({ limit: 8, load: () => 3, sleep })).toBe('quiet');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('waits until load drops', async () => {
    sleep.mockClear();
    const readings = [20, 15, 7];
    expect(await waitForHostLoad({ limit: 8, load: () => readings.shift() ?? 0, sleep, pollMs: 10 })).toBe('quiet');
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('gives up after the limit so a retry always happens', async () => {
    sleep.mockClear();
    expect(await waitForHostLoad({ limit: 8, load: () => 20, sleep, pollMs: 10, maxWaitMs: 30 })).toBe('timed_out');
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('stops when the build is cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await waitForHostLoad({ limit: 8, load: () => 20, sleep, signal: controller.signal })).toBe('aborted');
  });
});
