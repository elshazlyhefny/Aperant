/**
 * zeenha fork: the Memory page's Ollama panel reads the fixed `ollama`
 * container and can start it — and nothing else.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Reply = { stdout?: string; stderr?: string; error?: NodeJS.ErrnoException };
const dockerCalls: string[][] = [];
let replies: Record<string, Reply> = {};

vi.mock('child_process', () => ({
  execFile: (cmd: string, args: string[], _opts: unknown, cb: (e: unknown, out: string, err: string) => void) => {
    expect(cmd).toBe('docker');
    dockerCalls.push(args);
    const reply = replies[args[0]] ?? { error: Object.assign(new Error(`unexpected docker ${args[0]}`), {}) };
    setImmediate(() => cb(reply.error ?? null, reply.stdout ?? '', reply.stderr ?? ''));
  },
}));
vi.mock('../env-utils', () => ({ getAugmentedEnv: () => ({}) }));
vi.mock('../settings-utils', () => ({ readSettingsFile: () => ({}) }));
const resetMemoryService = vi.fn();
vi.mock('../ipc-handlers/context/memory-service-factory', () => ({ resetMemoryService: () => resetMemoryService() }));
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  return {
    ...real,
    promises: { ...real.promises, statfs: async () => ({ bavail: 1000, bsize: 4096, blocks: 4000 }) },
  };
});

import { getOllamaContainerStatus, parseDockerSize, startOllamaContainer } from '../ollama-container';

const inspect = (status: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify([
    {
      Image: 'sha256:abc',
      Config: { Image: 'ollama/ollama:0.35.1@sha256:292ee' },
      State: { Status: status, StartedAt: '2026-11-04T08:21:14Z', FinishedAt: '2026-10-25T02:10:55Z', ExitCode: 0 },
      HostConfig: { NanoCpus: 4_000_000_000 },
      ...extra,
    },
  ]);

let api: 'up' | 'down' = 'up';
function mockOllamaApi() {
  globalThis.fetch = vi.fn(async (url: string | URL) => {
    if (api === 'down') throw new Error('ECONNREFUSED');
    const path = String(url);
    if (path.endsWith('/api/tags')) {
      return new Response(JSON.stringify({ models: [{ name: 'qwen3-embedding:0.6b', size: 639150858 }] }));
    }
    return new Response(JSON.stringify({ models: [{ name: 'qwen3-embedding:0.6b', size: 700000000, expires_at: '2026-11-04T09:00:00Z' }] }));
  }) as typeof fetch;
}

beforeEach(() => {
  dockerCalls.length = 0;
  resetMemoryService.mockClear();
  api = 'up';
  mockOllamaApi();
  replies = {
    inspect: { stdout: inspect('running') },
    stats: { stdout: '{"CPUPerc":"1.50%","MemUsage":"146.2MiB / 3GiB"}' },
    image: { stdout: '9370091478\n' },
    info: { stdout: '/var/lib/docker\n' },
    start: { stdout: 'ollama\n' },
  };
});

describe('parseDockerSize', () => {
  it('reads the binary and decimal units docker stats prints', () => {
    expect(parseDockerSize('146.2MiB')).toBe(Math.round(146.2 * 1024 ** 2));
    expect(parseDockerSize(' 3GiB')).toBe(3 * 1024 ** 3);
    expect(parseDockerSize('780MB')).toBe(780e6);
    expect(parseDockerSize('12B')).toBe(12);
    expect(parseDockerSize('n/a')).toBeUndefined();
  });
});

describe('getOllamaContainerStatus', () => {
  it('reports a running container with CPU, memory, models and disk', async () => {
    const status = await getOllamaContainerStatus();
    expect(status).toMatchObject({
      docker: 'ok',
      container: 'running',
      image: 'ollama/ollama:0.35.1',
      imageBytes: 9370091478,
      cpuPercent: 1.5,
      cpuLimit: 4,
      memoryBytes: Math.round(146.2 * 1024 ** 2),
      memoryLimitBytes: 3 * 1024 ** 3,
      apiReachable: true,
      models: [{ name: 'qwen3-embedding:0.6b', bytes: 639150858 }],
      loadedModels: [{ name: 'qwen3-embedding:0.6b', bytes: 700000000, expiresAt: '2026-11-04T09:00:00Z' }],
      diskFreeBytes: 1000 * 4096,
      diskTotalBytes: 4000 * 4096,
    });
  });

  it('only ever asks Docker about the fixed container, read-only', async () => {
    await getOllamaContainerStatus();
    expect(dockerCalls).toContainEqual(['inspect', '--type', 'container', 'ollama']);
    expect(dockerCalls).toContainEqual(['stats', '--no-stream', '--format', '{{json .}}', 'ollama']);
    // `info` runs once per process (the Docker data dir is cached)
    for (const args of dockerCalls) expect(['image', 'info', 'inspect', 'stats']).toContain(args[0]);
  });

  it('reports a stopped container without sampling it', async () => {
    replies.inspect = { stdout: inspect('exited') };
    const status = await getOllamaContainerStatus();
    expect(status).toMatchObject({
      container: 'stopped', state: 'exited', exitCode: 0, finishedAt: '2026-10-25T02:10:55Z', apiReachable: false,
    });
    expect(status.cpuPercent).toBeUndefined();
    expect(dockerCalls.some((a) => a[0] === 'stats')).toBe(false);
  });

  it('says the container is missing when Docker does not know it', async () => {
    replies.inspect = { error: new Error('exit 1'), stderr: 'Error: No such object: ollama\n' };
    expect(await getOllamaContainerStatus()).toMatchObject({ docker: 'ok', container: 'missing' });
  });

  it('says why Docker could not be asked', async () => {
    replies.inspect = { error: Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }) };
    expect(await getOllamaContainerStatus()).toEqual({
      docker: 'unavailable', container: 'unknown', detail: 'Docker CLI not found on PATH',
    });

    replies.inspect = {
      error: new Error('exit 1'),
      stderr: '\npermission denied while trying to connect to the Docker daemon socket\n',
    };
    expect((await getOllamaContainerStatus()).detail).toBe(
      'permission denied while trying to connect to the Docker daemon socket',
    );
  });

  it('flags a running container whose API does not answer', async () => {
    api = 'down';
    const status = await getOllamaContainerStatus();
    expect(status.container).toBe('running');
    expect(status.apiReachable).toBe(false);
    expect(status.models).toBeUndefined();
  });
});

describe('startOllamaContainer', () => {
  it('starts only the fixed container, then drops the memory service so the model is detected again', async () => {
    const status = await startOllamaContainer();
    expect(dockerCalls[0]).toEqual(['start', 'ollama']);
    expect(resetMemoryService).toHaveBeenCalledTimes(1);
    expect(status.container).toBe('running');
  });

  it('reports Docker\'s reason and leaves memory alone when the start fails', async () => {
    replies.start = { error: new Error('exit 1'), stderr: 'Error response from daemon: No such container: ollama\n' };
    await expect(startOllamaContainer()).rejects.toThrow('Error response from daemon: No such container: ollama');
    expect(resetMemoryService).not.toHaveBeenCalled();
  });
});
