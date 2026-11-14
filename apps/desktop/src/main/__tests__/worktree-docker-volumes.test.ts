/**
 * zeenha fork: the volume names must equal what the project's bash scripts
 * create, or a cleanup silently removes nothing.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { skipOnWindows } from '../../__tests__/helpers/windows-skip';
import { dockerVolumesForWorktree, removeDockerVolumes } from '../worktree-docker-volumes';

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'wt-vols-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('dockerVolumesForWorktree', () => {
  it.skipIf(skipOnWindows('shells out to POSIX pwd -P and sha1sum'))('matches the key the bash scripts compute', () => {
    // Same steps as the scripts' `printf '%s' "$(pwd -P)" | sha1sum | cut -c1-10`, run without a shell.
    const physical = execFileSync('pwd', ['-P'], { cwd: dir }).toString().replace(/\n+$/, '');
    const key = execFileSync('sha1sum', { input: physical }).toString().slice(0, 10);
    expect(dockerVolumesForWorktree(dir)).toEqual([`zeenha_wt_${key}_vendor`, `zeenha_wt_${key}_frontend_dev_modules`]);
  });

  it.skipIf(skipOnWindows('creating a directory symlink needs privilege on Windows'))('follows symlinks like pwd -P does', () => {
    const link = join(dir, 'link');
    symlinkSync(dir, link);
    expect(dockerVolumesForWorktree(link)).toEqual(dockerVolumesForWorktree(dir));
  });
});

describe('removeDockerVolumes', () => {
  it('never throws, even for a volume docker cannot remove', async () => {
    await expect(removeDockerVolumes(['zeenha_wt_0000000000_does_not_exist'])).resolves.toBeUndefined();
  });
});
