/**
 * zeenha fork: the local `ollama` Docker container that serves agent-memory
 * embeddings.
 *
 * When it stops, memory silently falls back to keyword search (it was down
 * 2026-10-25 → 2026-11-04 before anyone noticed), so the Memory settings page
 * shows its state, resources and disk use, and can start it.
 *
 * Only two Docker operations exist here, both on the fixed container name:
 * read its status, and `docker start` it. Nothing from the renderer reaches
 * a command line.
 */

import { execFile } from 'child_process';
import { promises as fsPromises } from 'fs';
import { getAugmentedEnv } from './env-utils';
import { readSettingsFile } from './settings-utils';
import { resetMemoryService } from './ipc-handlers/context/memory-service-factory';
import type { OllamaContainerStatus } from '../shared/types';

export const OLLAMA_CONTAINER = 'ollama';
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DOCKER_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 60_000;
const API_TIMEOUT_MS = 3_000;
const API_READY_WAIT_MS = 30_000;

function docker(args: string[], timeout = DOCKER_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { env: getAugmentedEnv(), timeout, maxBuffer: 1024 * 1024, encoding: 'utf-8' }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stderr: String(stderr ?? '') }));
      } else {
        resolve(String(stdout));
      }
    });
  });
}

function ollamaBaseUrl(): string {
  const configured = readSettingsFile()?.ollamaBaseUrl;
  return (typeof configured === 'string' && configured.trim() ? configured.trim() : DEFAULT_OLLAMA_URL).replace(/\/+$/, '');
}

/** The first line Docker printed about a failure, or the error's own message. */
function dockerFailure(error: unknown): string {
  const err = error as NodeJS.ErrnoException & { stderr?: string };
  if (err.code === 'ENOENT') return 'Docker CLI not found on PATH';
  const line = (err.stderr ?? '').split('\n').map((l) => l.trim()).find(Boolean);
  return line ?? err.message ?? String(error);
}

function isMissingContainer(error: unknown): boolean {
  return /no such (object|container)/i.test(dockerFailure(error));
}

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12,
  kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
};

/** "146.2MiB" → bytes, as `docker stats` prints sizes. */
export function parseDockerSize(text: string): number | undefined {
  const match = text.trim().match(/^([\d.]+)\s*([a-z]+)$/i);
  const unit = match && SIZE_UNITS[match[2].toLowerCase()];
  return match && unit ? Math.round(Number.parseFloat(match[1]) * unit) : undefined;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(API_TIMEOUT_MS) });
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  }
}

interface DockerInspect {
  Image?: string;
  Config?: { Image?: string };
  State?: { Status?: string; StartedAt?: string; FinishedAt?: string; ExitCode?: number };
  HostConfig?: { NanoCpus?: number };
}

let dockerRootDir: string | null = null;

async function diskOfDocker(): Promise<{ diskFreeBytes?: number; diskTotalBytes?: number }> {
  try {
    dockerRootDir ??= (await docker(['info', '--format', '{{.DockerRootDir}}'])).trim();
    const fs = await fsPromises.statfs(dockerRootDir);
    return { diskFreeBytes: fs.bavail * fs.bsize, diskTotalBytes: fs.blocks * fs.bsize };
  } catch {
    return {};
  }
}

async function imageBytes(imageId: string | undefined): Promise<number | undefined> {
  if (!imageId) return undefined;
  try {
    const size = Number((await docker(['image', 'inspect', '--format', '{{.Size}}', imageId])).trim());
    return Number.isFinite(size) ? size : undefined;
  } catch {
    return undefined;
  }
}

async function liveUsage(): Promise<Partial<OllamaContainerStatus>> {
  try {
    const stats = JSON.parse(await docker(['stats', '--no-stream', '--format', '{{json .}}', OLLAMA_CONTAINER])) as {
      CPUPerc?: string;
      MemUsage?: string;
    };
    const [used, limit] = (stats.MemUsage ?? '').split('/');
    const cpu = Number.parseFloat(stats.CPUPerc ?? '');
    return {
      cpuPercent: Number.isFinite(cpu) ? cpu : undefined,
      memoryBytes: used ? parseDockerSize(used) : undefined,
      memoryLimitBytes: limit ? parseDockerSize(limit) : undefined,
    };
  } catch {
    return {};
  }
}

async function ollamaApi(): Promise<Partial<OllamaContainerStatus>> {
  const base = ollamaBaseUrl();
  const [tags, ps] = await Promise.all([
    fetchJson<{ models?: { name: string; size: number }[] }>(`${base}/api/tags`),
    fetchJson<{ models?: { name: string; size: number; expires_at?: string }[] }>(`${base}/api/ps`),
  ]);
  return {
    apiReachable: tags !== null,
    ...(tags && { models: (tags.models ?? []).map((m) => ({ name: m.name, bytes: m.size })) }),
    ...(ps && {
      loadedModels: (ps.models ?? []).map((m) => ({ name: m.name, bytes: m.size, expiresAt: m.expires_at })),
    }),
  };
}

export async function getOllamaContainerStatus(): Promise<OllamaContainerStatus> {
  let inspect: DockerInspect;
  try {
    [inspect] = JSON.parse(await docker(['inspect', '--type', 'container', OLLAMA_CONTAINER])) as DockerInspect[];
  } catch (error) {
    if (isMissingContainer(error)) return { docker: 'ok', container: 'missing', ...(await diskOfDocker()) };
    return { docker: 'unavailable', container: 'unknown', detail: dockerFailure(error) };
  }

  const state = inspect.State?.Status ?? 'unknown';
  const running = state === 'running';
  const nanoCpus = inspect.HostConfig?.NanoCpus ?? 0;
  const [usage, api, disk, image] = await Promise.all([
    running ? liveUsage() : Promise.resolve({}),
    running ? ollamaApi() : Promise.resolve({ apiReachable: false }),
    diskOfDocker(),
    imageBytes(inspect.Image),
  ]);

  return {
    docker: 'ok',
    container: running ? 'running' : 'stopped',
    state,
    startedAt: inspect.State?.StartedAt,
    finishedAt: inspect.State?.FinishedAt,
    exitCode: inspect.State?.ExitCode,
    image: inspect.Config?.Image?.split('@')[0],
    imageBytes: image,
    cpuLimit: nanoCpus > 0 ? nanoCpus / 1e9 : undefined,
    ...usage,
    ...api,
    ...disk,
  };
}

async function waitForApi(): Promise<void> {
  const deadline = Date.now() + API_READY_WAIT_MS;
  while (Date.now() < deadline) {
    if (await fetchJson(`${ollamaBaseUrl()}/api/tags`)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * `docker start ollama`, wait until its API answers, then drop the memory
 * service so the next memory call detects the embedding model again (the
 * provider is otherwise chosen once per app session).
 */
export async function startOllamaContainer(): Promise<OllamaContainerStatus> {
  try {
    await docker(['start', OLLAMA_CONTAINER], START_TIMEOUT_MS);
  } catch (error) {
    throw new Error(dockerFailure(error));
  }
  await waitForApi();
  resetMemoryService();
  return getOllamaContainerStatus();
}
