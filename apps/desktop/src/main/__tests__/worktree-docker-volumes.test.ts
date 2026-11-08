/**
 * zeenha fork: the volume names must equal what the project's bash scripts
 * create, or a cleanup silently removes nothing.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dockerVolumesForWorktree, removeDockerVolumes } from '../worktree-docker-volumes';

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'wt-vols-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('dockerVolumesForWorktree', () => {
  it('matches the key the bash scripts compute', () => {
    const key = execFileSync('bash', ['-c', `cd "$1" && printf '%s' "$(pwd -P)" | sha1sum | cut -c1-10`, 'bash', dir]).toString().trim();
    expect(dockerVolumesForWorktree(dir)).toEqual([`zeenha_wt_${key}_vendor`, `zeenha_wt_${key}_frontend_dev_modules`]);
  });

  it('follows symlinks like pwd -P does', () => {
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
