/**
 * zeenha fork: give every Vitest run its own temp directory and delete it when
 * the run ends.
 *
 * About 60 test files create fixtures with `fs.mkdtempSync(path.join(os.tmpdir(), ...))`
 * and never remove them. On a machine where agents run the suite many times a
 * day that left ~60,000 directories (3.7 GB) in /tmp in about a week, and on
 * Ubuntu /tmp is a tmpfs, so every one of those bytes was held in RAM.
 *
 * Fixing each test would not stay fixed: the next new test brings the leak
 * back. Instead this global setup points TMPDIR/TEMP/TMP (what `os.tmpdir()`
 * reads on POSIX and Windows) at a per-run directory before the worker pool
 * starts, so workers and the child processes they spawn all inherit it, and
 * the teardown removes the whole directory in one step.
 *
 * A run that is killed (SIGKILL, a closed terminal, an agent timeout) never
 * reaches its teardown, so setup also removes earlier runs' directories whose
 * owning process no longer exists.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const RUN_DIR_PREFIX = 'aperant-vitest-';

const TMP_VARS = ['TMPDIR', 'TEMP', 'TMP'] as const;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Remove run directories left by earlier runs whose process has exited. */
export function sweepAbandonedRunDirs(base: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(base);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(RUN_DIR_PREFIX)) continue;
    const pid = Number.parseInt(name.slice(RUN_DIR_PREFIX.length), 10);
    if (!Number.isInteger(pid) || pid <= 0 || isProcessAlive(pid)) continue;
    fs.rmSync(path.join(base, name), { recursive: true, force: true, maxRetries: 3 });
  }
}

export default function setup(): () => void {
  const base = os.tmpdir();
  sweepAbandonedRunDirs(base);

  const runDir = fs.mkdtempSync(path.join(base, `${RUN_DIR_PREFIX}${process.pid}-`));
  const previous = TMP_VARS.map((name) => [name, process.env[name]] as const);
  for (const name of TMP_VARS) process.env[name] = runDir;

  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(runDir, { recursive: true, force: true, maxRetries: 3 });
  };
}
