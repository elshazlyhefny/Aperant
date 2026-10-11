/**
 * zeenha fork: the two git checks that protect unsaved work, against a real
 * repository. cleanupWorktree deletes the directory by hand, so "dirty" must
 * be detected for real, not just in a mock.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../cli-tool-manager', () => ({ getToolPath: (tool: string) => tool }));
vi.mock('../env-utils', () => ({ getAugmentedEnv: () => ({ ...process.env }) }));

import { readPullRequestState, worktreeHasUncommittedChanges, worktreeHeadCommit } from '../worktree-auto-cleanup';

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf-8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  }).trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'merged-cleanup-'));
  git('init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-qm', 'init');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('worktreeHasUncommittedChanges', () => {
  it('is false for a clean tree', async () => {
    expect(await worktreeHasUncommittedChanges(repo)).toBe(false);
  });

  it('is true for a modified tracked file', async () => {
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    expect(await worktreeHasUncommittedChanges(repo)).toBe(true);
  });

  it('is true for a new untracked file', async () => {
    writeFileSync(join(repo, 'b.txt'), 'new\n');
    expect(await worktreeHasUncommittedChanges(repo)).toBe(true);
  });

  it("ignores Aperant's own .auto-claude files", async () => {
    mkdirSync(join(repo, '.auto-claude', 'specs'), { recursive: true });
    writeFileSync(join(repo, '.auto-claude', 'specs', 'log.json'), '{}');
    expect(await worktreeHasUncommittedChanges(repo)).toBe(false);
  });

  it('treats a directory git cannot read as dirty', async () => {
    expect(await worktreeHasUncommittedChanges(join(repo, 'missing'))).toBe(true);
  });
});

describe('worktreeHeadCommit', () => {
  it('returns the full HEAD sha', async () => {
    expect(await worktreeHeadCommit(repo)).toBe(git('rev-parse', 'HEAD'));
  });

  it('changes when a commit is made after the merge', async () => {
    const before = await worktreeHeadCommit(repo);
    writeFileSync(join(repo, 'a.txt'), 'later\n');
    git('commit', '-qam', 'after merge');
    expect(await worktreeHeadCommit(repo)).not.toBe(before);
  });
});

describe('readPullRequestState', () => {
  it('refuses anything that is not a github.com pull request URL, without calling gh', async () => {
    expect(await readPullRequestState('https://evil.example/o/r/pull/1', repo)).toBeNull();
    expect(await readPullRequestState('https://github.com/o/r/pull/1; rm -rf /', repo)).toBeNull();
  });
});
