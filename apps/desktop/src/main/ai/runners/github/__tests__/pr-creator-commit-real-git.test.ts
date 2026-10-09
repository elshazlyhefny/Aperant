/**
 * zeenha fork: Create PR commits work the coder left uncommitted. Run against
 * real git, because the exclusion pathspec is what keeps Aperant's own
 * .auto-claude files out of the PR and a fake cannot prove git accepts it.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../env-utils', () => ({ getAugmentedEnv: () => ({ ...process.env }) }));

import { commitPendingWork } from '../pr-creator';

let repo: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'pr-commit-'));
  git('init', '-q', '-b', 'auto-claude/001-x');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), 'hello\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('commitPendingWork (real git)', () => {
  it('commits edited and new files but never .auto-claude', async () => {
    writeFileSync(join(repo, 'README.md'), 'hello, world\n');
    writeFileSync(join(repo, 'new.txt'), 'new\n');
    mkdirSync(join(repo, '.auto-claude', 'specs'), { recursive: true });
    writeFileSync(join(repo, '.auto-claude', 'specs', 'plan.json'), '{}');

    expect(await commitPendingWork(repo, 'git', 'Fix one typo')).toBeNull();

    expect(git('log', '-1', '--format=%s')).toBe('Fix one typo');
    expect(git('show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['README.md', 'new.txt']);
    expect(git('status', '--porcelain')).toBe('?? .auto-claude/');
  });

  it('does nothing when only .auto-claude changed', async () => {
    mkdirSync(join(repo, '.auto-claude'), { recursive: true });
    writeFileSync(join(repo, '.auto-claude', 'x.json'), '{}');
    expect(await commitPendingWork(repo, 'git', 'unused')).toBeNull();
    expect(git('rev-list', '--count', 'HEAD')).toBe('1');
  });

  it('reports a commit refused by a hook', async () => {
    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "lint failed" >&2\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(repo, 'README.md'), 'changed\n');
    expect(await commitPendingWork(repo, 'git', 'm')).toContain('lint failed');
    expect(git('rev-list', '--count', 'HEAD')).toBe('1');
  });
});
