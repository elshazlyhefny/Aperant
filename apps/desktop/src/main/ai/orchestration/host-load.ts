/**
 * zeenha fork: wait for a quieter machine before retrying work that failed
 * because of load.
 *
 * Full suites and type checks from parallel tasks can overload the laptop until
 * a QA session is killed with no verdict. Retrying at once fails the same way.
 */

import { cpus, loadavg } from 'node:os';

export type HostLoadWait = 'quiet' | 'timed_out' | 'aborted';

export interface HostLoadOptions {
  signal?: AbortSignal;
  /** Load average at or under this counts as quiet. Default: one per CPU. */
  limit?: number;
  maxWaitMs?: number;
  pollMs?: number;
  /** Injected by tests. */
  load?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/** Resolves once load is at or under the limit. A timeout is not an error: the caller goes ahead. */
export async function waitForHostLoad(options: HostLoadOptions = {}): Promise<HostLoadWait> {
  const {
    signal,
    limit = cpus().length,
    maxWaitMs = 15 * 60 * 1000,
    pollMs = 30 * 1000,
    load = () => loadavg()[0],
    sleep = abortableSleep,
  } = options;

  let waited = 0;
  for (;;) {
    if (signal?.aborted) return 'aborted';
    if (load() <= limit) return 'quiet';
    if (waited >= maxWaitMs) return 'timed_out';
    await sleep(pollMs, signal);
    waited += pollMs;
  }
}
