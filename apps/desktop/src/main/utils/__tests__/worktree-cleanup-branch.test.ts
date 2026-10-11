/**
 * zeenha fork: cleanupWorktree must delete the task's branch and never main.
 *
 * Regression for 2026-10-11: for a leftover folder whose .git link was gone,
 * `git rev-parse --abbrev-ref HEAD` inside it walked up to the parent repository
 * and answered "main", so `git branch -D main` was attempted. It was saved only
 * because main was checked out in the primary worktree.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../cli-tool-manager', () => ({ getToolPath: (tool: string) => tool }));

import { cleanupWorktree } from '../worktree-cleanup';

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf-8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  }).trim();
const branches = () => git('branch', '--format=%(refname:short)').split('\n').filter(Boolean).sort();
const tasksDir = () => join(repo, '.auto-claude', 'worktrees', 'tasks');

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'wt-cleanup-branch-'));
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-qm', 'init');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('cleanupWorktree branch deletion', () => {
  it('deletes the task branch for a LEFTOVER folder (no .git) and leaves main alone', async () => {
    // A second branch checked out nowhere, so `git branch -D` of the wrong one would succeed.
    git('branch', 'auto-claude/016-x');
    git('branch', 'keep-me');
    git('checkout', '-q', 'keep-me'); // the parent's HEAD is now NOT main: a wrong delete of main would succeed
    const leftover = join(tasksDir(), '016-x');
    mkdirSync(join(leftover, 'frontend', '.nuxt'), { recursive: true });
    writeFileSync(join(leftover, 'frontend', '.nuxt', 'x.d.ts'), 'x');

    const result = await cleanupWorktree({ worktreePath: leftover, projectPath: repo, specId: '016-x', deleteBranch: true });

    expect(result.success).toBe(true);
    expect(existsSync(leftover)).toBe(false);
    expect(branches()).toEqual(['keep-me', 'main']);
  });

  it('deletes the branch of a REAL worktree, read from its HEAD', async () => {
    git('worktree', 'add', '-q', '-b', 'auto-claude/017-y', join(tasksDir(), '017-y'));

    const result = await cleanupWorktree({ worktreePath: join(tasksDir(), '017-y'), projectPath: repo, specId: '017-y', deleteBranch: true });

    expect(result.success).toBe(true);
    expect(branches()).toEqual(['main']);
  });

  it('refuses to delete a branch that is not a task or terminal branch, even when named explicitly', async () => {
    git('branch', 'feature');
    const leftover = join(tasksDir(), '018-z');
    mkdirSync(leftover, { recursive: true });

    const result = await cleanupWorktree({
      worktreePath: leftover,
      projectPath: repo,
      specId: '018-z',
      deleteBranch: true,
      branchName: 'feature',
    });

    expect(branches()).toEqual(['feature', 'main']);
    expect(result.warnings.join(' ')).toMatch(/not deleted/);
  });
});
