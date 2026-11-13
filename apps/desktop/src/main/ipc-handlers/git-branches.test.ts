import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Handler = (args: string[], opts: Record<string, unknown>) => Promise<string>;

const { execMock, state } = vi.hoisted(() => {
  const state = { handler: null as null | ((args: string[], opts: Record<string, unknown>) => Promise<string>) };
  const execMock = vi.fn((_cmd: string, args: string[], opts: Record<string, unknown>) => {
    if (!state.handler) return Promise.resolve({ stdout: '', stderr: '' });
    return state.handler(args, opts).then(stdout => ({ stdout, stderr: '' }));
  });
  return { execMock, state };
});

vi.mock('child_process', async () => {
  const { promisify } = await import('util');
  const execFile = vi.fn();
  (execFile as unknown as Record<symbol, unknown>)[promisify.custom] = execMock;
  return { execFile, default: { execFile } };
});

vi.mock('../cli-tool-manager', () => ({
  getToolPath: vi.fn(() => 'git')
}));

import {
  FETCH_MIN_INTERVAL_MS,
  getGitBranches,
  getGitBranchesWithInfo,
  getCurrentGitBranch,
  getDefaultRemoteBranchRef,
  scheduleBackgroundFetch,
  resetBackgroundFetchStateForTests
} from './git-branches';

function setHandler(h: Handler): void {
  state.handler = h;
}

function fetchCalls(): unknown[][] {
  return execMock.mock.calls.filter(c => (c[1] as string[])[0] === 'fetch');
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('git-branches', () => {
  beforeEach(() => {
    execMock.mockClear();
    state.handler = null;
    resetBackgroundFetchStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('getGitBranches', () => {
    it('sorts local first and drops origin/x when local x exists', async () => {
      setHandler(async () => 'origin/zeta\nmain\norigin/main\norigin/feature\nbeta\norigin/HEAD\n');
      expect(await getGitBranches('/repo')).toEqual(['beta', 'main', 'origin/feature', 'origin/zeta']);
    });

    it('removes HEAD entries', async () => {
      setHandler(async () => 'main\norigin/HEAD\nremotes/origin/HEAD\n');
      expect(await getGitBranches('/repo')).toEqual(['main']);
    });

    it('dedups exact duplicates', async () => {
      setHandler(async () => 'main\nmain\n');
      expect(await getGitBranches('/repo')).toEqual(['main']);
    });

    it('never calls fetch', async () => {
      setHandler(async () => 'main\n');
      await getGitBranches('/repo');
      expect(fetchCalls()).toHaveLength(0);
    });

    it('returns [] on error', async () => {
      setHandler(async () => {
        throw new Error('boom');
      });
      expect(await getGitBranches('/repo')).toEqual([]);
    });

    it('handles 5000 branches quickly', async () => {
      const lines: string[] = [];
      for (let i = 0; i < 5000; i++) {
        lines.push(`feature-${i}`, `origin/feature-${i}`, `origin/only-${i}`);
      }
      setHandler(async () => lines.join('\n'));
      const start = Date.now();
      const result = await getGitBranches('/repo');
      expect(Date.now() - start).toBeLessThan(5000);
      expect(result).toHaveLength(10000);
    });
  });

  describe('getGitBranchesWithInfo', () => {
    it('returns shape, isCurrent and dedups remotes', async () => {
      setHandler(async args => {
        if (args[0] === 'rev-parse') return 'main\n';
        if (args[0] === 'branch' && args[1] === '-r') return 'origin/main\norigin/HEAD\norigin/remote-b\norigin/remote-a\n';
        return 'main\nalpha\n';
      });
      const result = await getGitBranchesWithInfo('/repo');
      expect(result).toEqual([
        { name: 'alpha', type: 'local', displayName: 'alpha', isCurrent: false },
        { name: 'main', type: 'local', displayName: 'main', isCurrent: true },
        { name: 'remote-a', type: 'remote', displayName: 'remote-a', isCurrent: false },
        { name: 'remote-b', type: 'remote', displayName: 'remote-b', isCurrent: false }
      ]);
      expect(fetchCalls()).toHaveLength(0);
    });

    it('degrades when current-branch and remote calls fail', async () => {
      setHandler(async args => {
        if (args[0] === 'rev-parse' || args.includes('-r')) throw new Error('fail');
        return 'main\n';
      });
      expect(await getGitBranchesWithInfo('/repo')).toEqual([
        { name: 'main', type: 'local', displayName: 'main', isCurrent: false }
      ]);
    });

    it('returns [] when local listing fails', async () => {
      setHandler(async () => {
        throw new Error('fail');
      });
      expect(await getGitBranchesWithInfo('/repo')).toEqual([]);
    });
  });

  describe('getCurrentGitBranch / getDefaultRemoteBranchRef', () => {
    it('returns trimmed values and null on error', async () => {
      setHandler(async args => (args[0] === 'rev-parse' ? 'dev\n' : 'refs/remotes/origin/main\n'));
      expect(await getCurrentGitBranch('/repo')).toBe('dev');
      expect(await getDefaultRemoteBranchRef('/repo')).toBe('refs/remotes/origin/main');
      setHandler(async () => {
        throw new Error('x');
      });
      expect(await getCurrentGitBranch('/repo')).toBeNull();
      expect(await getDefaultRemoteBranchRef('/repo')).toBeNull();
    });
  });

  describe('scheduleBackgroundFetch', () => {
    it('fetches with prune and a 10s timeout then calls onFetched', async () => {
      setHandler(async () => '');
      const onFetched = vi.fn();
      scheduleBackgroundFetch('/repo', onFetched);
      await flush();
      const calls = fetchCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toEqual(['fetch', '--prune']);
      expect((calls[0][2] as { timeout: number }).timeout).toBe(10000);
      expect(onFetched).toHaveBeenCalledWith('/repo');
    });

    it('does not fetch again within the interval', async () => {
      setHandler(async () => '');
      scheduleBackgroundFetch('/repo', vi.fn());
      await flush();
      scheduleBackgroundFetch('/repo', vi.fn());
      await flush();
      expect(fetchCalls()).toHaveLength(1);
    });

    it('only fetches once for concurrent calls', async () => {
      let release: () => void = () => undefined;
      setHandler(() => new Promise<string>(res => {
        release = () => res('');
      }));
      const onFetched = vi.fn();
      scheduleBackgroundFetch('/repo', onFetched);
      scheduleBackgroundFetch('/repo', onFetched);
      scheduleBackgroundFetch('/repo', onFetched);
      expect(fetchCalls()).toHaveLength(1);
      release();
      await flush();
      expect(onFetched).toHaveBeenCalledTimes(1);
    });

    it('swallows failures, skips onFetched and still rate limits', async () => {
      setHandler(async () => {
        throw new Error('offline');
      });
      const onFetched = vi.fn();
      expect(() => scheduleBackgroundFetch('/repo', onFetched)).not.toThrow();
      await flush();
      expect(onFetched).not.toHaveBeenCalled();
      scheduleBackgroundFetch('/repo', onFetched);
      await flush();
      expect(fetchCalls()).toHaveLength(1);
    });

    it('allows a new fetch after the interval', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      setHandler(async () => '');
      scheduleBackgroundFetch('/repo', vi.fn());
      await flush();
      vi.setSystemTime(Date.now() + FETCH_MIN_INTERVAL_MS + 1);
      scheduleBackgroundFetch('/repo', vi.fn());
      await flush();
      expect(fetchCalls()).toHaveLength(2);
    });
  });
});
