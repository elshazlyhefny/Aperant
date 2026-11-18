/**
 * Stop requests for the headless daemon
 *
 * zeenha fork: `stop-spec` runs in a different process from the `serve`
 * daemon that owns the running task. The CLI drops a small JSON file in
 * `<project>/.auto-claude/.locks/` and the daemon picks it up on its next
 * poll. Electron-free on purpose.
 */

import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, unlinkSync } from 'fs';
import { hostname as osHostname } from 'os';
import path from 'path';
import { writeFileAtomicSync } from '../utils/atomic-file';
import { readLockHolder, type QueueLockHolder } from '../utils/project-queue-lock';

export interface StopRequest {
  specId: string;
  requeue: boolean;
}

export type LiveDaemonResult =
  | { ok: true; holder: QueueLockHolder }
  | { ok: false; message: string };

export interface FindLiveDaemonOptions {
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
  staleMs?: number;
  hostname?: string;
}

const SPEC_ID_RE = /^[A-Za-z0-9._-]+$/;
const REQUEST_FILE_RE = /^stop-request-[A-Za-z0-9._-]+\.json$/;
const MAX_SPEC_ID_LENGTH = 200;
const MAX_REQUEST_BYTES = 4096;
const DEFAULT_STALE_MS = 2 * 60_000;

export function getStopRequestDir(projectPath: string): string {
  return path.join(projectPath, '.auto-claude', '.locks');
}

function isValidSpecId(specId: unknown): specId is string {
  return (
    typeof specId === 'string' &&
    specId.length > 0 &&
    specId.length <= MAX_SPEC_ID_LENGTH &&
    SPEC_ID_RE.test(specId) &&
    specId !== '.' &&
    specId !== '..'
  );
}

/** Write a stop request file and return its path. Throws on an invalid specId. */
export function writeStopRequest(
  projectPath: string,
  request: { specId: string; requeue: boolean }
): string {
  if (!isValidSpecId(request.specId)) {
    throw new Error(`Invalid spec id: ${JSON.stringify(request.specId)}`);
  }
  const dir = getStopRequestDir(projectPath);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `stop-request-${request.specId}.json`);
  writeFileAtomicSync(
    file,
    JSON.stringify({
      specId: request.specId,
      requeue: Boolean(request.requeue),
      requestedAt: new Date().toISOString()
    })
  );
  return file;
}

function removeQuietly(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // already gone
  }
}

/**
 * Read and delete every pending stop request. Files are always removed after
 * being looked at, valid or not, so a bad file cannot wedge the poll loop.
 */
export function consumeStopRequests(
  projectPath: string,
  log?: (message: string) => void
): StopRequest[] {
  const dir = getStopRequestDir(projectPath);
  let names: string[];
  let realDir: string;
  try {
    names = readdirSync(dir).filter((n) => n.startsWith('stop-request-') && n.endsWith('.json'));
    realDir = realpathSync(dir);
  } catch {
    return [];
  }

  const results: StopRequest[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (!REQUEST_FILE_RE.test(name) || name.length > MAX_SPEC_ID_LENGTH + 'stop-request-.json'.length) {
        log?.(`Ignoring stop request with invalid name: ${name}`);
        removeQuietly(file);
        continue;
      }
      const stat = lstatSync(file);
      if (!stat.isFile()) {
        // Symlinks and others: drop the entry itself, never follow it
        log?.(`Ignoring stop request that is not a regular file: ${name}`);
        removeQuietly(file);
        continue;
      }
      if (path.dirname(realpathSync(file)) !== realDir) {
        log?.(`Ignoring stop request outside the locks folder: ${name}`);
        removeQuietly(file);
        continue;
      }
      if (stat.size > MAX_REQUEST_BYTES) {
        log?.(`Ignoring oversized stop request: ${name}`);
        removeQuietly(file);
        continue;
      }
      const raw = readFileSync(file, 'utf-8');
      removeQuietly(file);
      const data = JSON.parse(raw) as { specId?: unknown; requeue?: unknown } | null;
      if (!data || !isValidSpecId(data.specId)) {
        log?.(`Ignoring stop request with invalid spec id: ${name}`);
        continue;
      }
      results.push({ specId: data.specId, requeue: Boolean(data.requeue) });
    } catch {
      log?.(`Ignoring unreadable stop request: ${name}`);
      removeQuietly(file);
    }
  }
  return results;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Find a live serve daemon holding the project queue lock. */
export function findLiveDaemon(
  projectPath: string,
  opts: FindLiveDaemonOptions = {}
): LiveDaemonResult {
  const holder = readLockHolder(projectPath);
  if (!holder) {
    return { ok: false, message: 'No serve daemon is running for this project.' };
  }
  if (holder.kind !== 'daemon') {
    return {
      ok: false,
      message: 'The project queue is held by the desktop app, not a serve daemon. Stop the task from the desktop app.'
    };
  }
  const now = opts.now ?? Date.now;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const host = opts.hostname ?? osHostname();
  if (holder.host === host && !isPidAlive(holder.pid)) {
    return { ok: false, message: `The serve daemon lock is stale (pid ${holder.pid} is not running).` };
  }
  const beat = Date.parse(holder.heartbeatAt);
  if (Number.isNaN(beat) || now() - beat > staleMs) {
    return { ok: false, message: 'The serve daemon lock is stale (no recent heartbeat).' };
  }
  return { ok: true, holder };
}
