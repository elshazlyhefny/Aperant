import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../cli-tool-manager', () => ({ getToolPath: () => 'git' }));

import {
  detectTrunkBranch,
  normalizeBranchName,
  resolveTaskBaseBranch,
  resolveTaskBaseBranchWithSource,
} from '../base-branch';
import { getEffectiveBaseBranch } from '../ipc-handlers/task/worktree-git-utils';

const SPEC = '001-x';
let roots: string[] = [];

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
}

function makeRepo(branch: string, extraBranches: string[] = []): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'base-branch-'));
  roots.push(dir);
  git(dir, 'init', '-b', branch);
  git(dir, 'commit', '--allow-empty', '-m', 'init', '--no-gpg-sign');
  for (const b of extraBranches) git(dir, 'branch', b);
  return dir;
}

function writeMetadata(root: string, baseBranch: unknown, autoBuildPath = '.auto-claude') {
  const dir = path.join(root, autoBuildPath, 'specs', SPEC);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task_metadata.json'), JSON.stringify({ baseBranch }));
}

beforeEach(() => {
  roots = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

describe('normalizeBranchName', () => {
  it.each([
    ['main', 'main'],
    ['  dev  ', 'dev'],
    ['origin/feat/x', 'feat/x'],
    ['feat/x', 'feat/x'],
    ['__project_default__', undefined],
    ['', undefined],
    ['   ', undefined],
    ['a b', undefined],
    ['--upload-pack=x', undefined],
    [undefined, undefined],
    [42, undefined],
    [null, undefined],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeBranchName(input)).toBe(expected);
  });
});

describe('detectTrunkBranch', () => {
  it('detects main', () => {
    expect(detectTrunkBranch(makeRepo('main'))).toBe('main');
  });
  it('detects master when only master exists', () => {
    expect(detectTrunkBranch(makeRepo('master'))).toBe('master');
  });
  it('prefers main when both exist', () => {
    expect(detectTrunkBranch(makeRepo('master', ['main']))).toBe('main');
  });
  it('returns undefined when neither exists', () => {
    expect(detectTrunkBranch(makeRepo('trunk'))).toBeUndefined();
  });
  it('tolerates an undefined path', () => {
    expect(detectTrunkBranch(undefined as unknown as string)).toBeUndefined();
  });
});

describe('resolveTaskBaseBranch precedence', () => {
  it('override beats metadata and settings', () => {
    const root = makeRepo('main');
    writeMetadata(root, 'meta');
    const r = resolveTaskBaseBranchWithSource({
      project: { path: root, settings: { mainBranch: 'settings' } },
      specId: SPEC,
      override: 'over',
    });
    expect(r).toEqual({ branch: 'over', source: 'override' });
  });

  it('invalid override falls through to metadata', () => {
    const root = makeRepo('main');
    writeMetadata(root, 'meta');
    expect(
      resolveTaskBaseBranch({ project: { path: root }, specId: SPEC, override: '--upload-pack=x' })
    ).toBe('meta');
  });

  it('metadata beats settings', () => {
    const root = makeRepo('main');
    writeMetadata(root, 'meta');
    const r = resolveTaskBaseBranchWithSource({
      project: { path: root, settings: { mainBranch: 'settings' } },
      specId: SPEC,
    });
    expect(r).toEqual({ branch: 'meta', source: 'task_metadata' });
  });

  it('strips origin/ from metadata', () => {
    const root = makeRepo('main');
    writeMetadata(root, 'origin/feat/x');
    expect(resolveTaskBaseBranch({ project: { path: root }, specId: SPEC })).toBe('feat/x');
  });

  it.each(['__project_default__', 'a b', '--upload-pack=x'])(
    'metadata %j falls through to settings',
    (value) => {
      const root = makeRepo('main');
      writeMetadata(root, value);
      const r = resolveTaskBaseBranchWithSource({
        project: { path: root, settings: { mainBranch: 'settings' } },
        specId: SPEC,
      });
      expect(r).toEqual({ branch: 'settings', source: 'project_settings' });
    }
  );

  it('uses settings.mainBranch without metadata', () => {
    const root = makeRepo('main');
    expect(
      resolveTaskBaseBranchWithSource({ project: { path: root, settings: { mainBranch: 'develop' } }, specId: SPEC })
    ).toEqual({ branch: 'develop', source: 'project_settings' });
  });

  it('strips origin/ from settings', () => {
    const root = makeRepo('main');
    expect(
      resolveTaskBaseBranch({ project: { path: root, settings: { mainBranch: 'origin/develop' } }, specId: SPEC })
    ).toBe('develop');
  });

  it('ignores an invalid settings value and detects trunk', () => {
    const root = makeRepo('master');
    expect(
      resolveTaskBaseBranchWithSource({ project: { path: root, settings: { mainBranch: 'a b' } }, specId: SPEC })
    ).toEqual({ branch: 'master', source: 'detected' });
  });

  it('master-only repo resolves to master', () => {
    const root = makeRepo('master');
    expect(resolveTaskBaseBranch({ project: { path: root }, specId: SPEC })).toBe('master');
  });

  it('repo with main and master resolves to main', () => {
    const root = makeRepo('master', ['main']);
    expect(resolveTaskBaseBranch({ project: { path: root }, specId: SPEC })).toBe('main');
  });

  it('no trunk and no settings falls back to main', () => {
    const root = makeRepo('trunk');
    expect(resolveTaskBaseBranchWithSource({ project: { path: root }, specId: SPEC })).toEqual({
      branch: 'main',
      source: 'fallback',
    });
  });
});

describe('resolveTaskBaseBranch inputs', () => {
  it('honours a custom autoBuildPath', () => {
    const root = makeRepo('main');
    writeMetadata(root, 'custom-meta', '.custom');
    writeMetadata(root, 'default-meta', '.auto-claude');
    expect(
      resolveTaskBaseBranch({ project: { path: root, autoBuildPath: '.custom' }, specId: SPEC })
    ).toBe('custom-meta');
  });

  it('does not read .auto-claude when a custom autoBuildPath is set', () => {
    const root = makeRepo('main');
    writeMetadata(root, 'default-meta', '.auto-claude');
    expect(
      resolveTaskBaseBranch({ project: { path: root, autoBuildPath: '.custom' }, specId: SPEC })
    ).toBe('main');
  });

  it('tolerates undefined specId and path', () => {
    expect(
      resolveTaskBaseBranch({ project: { path: undefined as unknown as string }, specId: undefined as unknown as string })
    ).toBe('main');
    const root = makeRepo('master');
    expect(
      resolveTaskBaseBranch({ project: { path: root }, specId: undefined as unknown as string })
    ).toBe('master');
  });
});

describe('getEffectiveBaseBranch agreement', () => {
  it('agrees with resolveTaskBaseBranch on a master-only repo', () => {
    const root = makeRepo('master');
    expect(getEffectiveBaseBranch(root, SPEC)).toBe('master');
    expect(getEffectiveBaseBranch(root, SPEC)).toBe(
      resolveTaskBaseBranch({ project: { path: root }, specId: SPEC })
    );
  });

  it('agrees when metadata and settings are present', () => {
    const root = makeRepo('main');
    writeMetadata(root, 'meta');
    expect(getEffectiveBaseBranch(root, SPEC, 'settings')).toBe(
      resolveTaskBaseBranch({ project: { path: root, settings: { mainBranch: 'settings' } }, specId: SPEC })
    );
  });
});
