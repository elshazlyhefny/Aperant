/**
 * zeenha fork: remove the Docker volumes a deleted worktree leaves behind.
 *
 * The project's test scripts used to give every checkout its own vendor and
 * node_modules volumes, named after a hash of the checkout's real path. Nothing
 * removed them when the worktree went: 136 volumes and 45 GB on 2026-11-08 with
 * one task worktree alive. New runs share volumes by lockfile, but a branch cut
 * before that change still creates these.
 *
 * The names must match scripts/test-backend.sh and scripts/lib/frontend-deps.sh:
 * sha1 of `pwd -P`, first 10 hex characters.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Call this while the folder still exists: the name is built from its real path. */
export function dockerVolumesForWorktree(worktreePath: string): string[] {
  let real = worktreePath;
  try {
    real = realpathSync(worktreePath);
  } catch {
    // Already gone: the given path is the best remaining answer.
  }
  const key = createHash('sha1').update(real).digest('hex').slice(0, 10);
  return [`zeenha_wt_${key}_vendor`, `zeenha_wt_${key}_frontend_dev_modules`];
}

/**
 * Best effort and never throws. Docker refuses to remove a volume that is in
 * use, and "no such volume" is the normal case for most worktrees.
 */
export async function removeDockerVolumes(volumes: string[]): Promise<void> {
  await Promise.all(
    volumes.map((volume) => execFileAsync('docker', ['volume', 'rm', volume], { timeout: 30_000 }).catch(() => undefined)),
  );
}
