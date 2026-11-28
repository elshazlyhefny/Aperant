import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUN_DIR_PREFIX, sweepAbandonedRunDirs } from './global-tmpdir';

describe('global-tmpdir (zeenha fork)', () => {
  it('points os.tmpdir() inside test workers at the per-run directory', () => {
    // If the global setup's env change did not reach the worker, os.tmpdir()
    // would be the system temp dir and every mkdtemp fixture would leak again.
    expect(path.basename(os.tmpdir())).toMatch(new RegExp(`^${RUN_DIR_PREFIX}\\d+-`));
  });

  it('removes only run directories whose owning process has exited', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'));

    // spawnSync waits for the child to exit, so its pid is (almost certainly) free.
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
    expect(deadPid).toBeGreaterThan(0);

    const abandoned = path.join(base, `${RUN_DIR_PREFIX}${deadPid}-abc123`);
    const live = path.join(base, `${RUN_DIR_PREFIX}${process.pid}-def456`);
    const unrelated = path.join(base, 'create-pr-xyz');
    const malformed = path.join(base, `${RUN_DIR_PREFIX}notapid`);
    for (const dir of [abandoned, live, unrelated, malformed]) {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'f'), 'x');
    }

    sweepAbandonedRunDirs(base);

    expect(fs.existsSync(abandoned)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
    expect(fs.existsSync(malformed)).toBe(true);
  });

  it('does nothing when the base directory is missing', () => {
    expect(() => sweepAbandonedRunDirs(path.join(os.tmpdir(), 'does-not-exist'))).not.toThrow();
  });
});
