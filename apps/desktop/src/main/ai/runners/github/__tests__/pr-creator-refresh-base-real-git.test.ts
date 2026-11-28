/**
 * zeenha fork: Create PR merges the latest base into the task branch before it
 * pushes. Run against real git with a bare "origin", because what matters is
 * what git does with the fetch, the merge and the abort.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../env-utils', () => ({
  getAugmentedEnv: () => ({
    ...process.env,
    LC_ALL: 'C',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 't@example.com',
  }),
}));
vi.mock('../../../client/factory', () => ({
  createSimpleClient: vi.fn(async () => ({ model: {}, systemPrompt: '' })),
}));
vi.mock('ai', () => ({ generateText: vi.fn(async () => ({ text: '## Summary\n- body' })) }));
const warn = vi.hoisted(() => vi.fn());
vi.mock('../../../../log-port', () => ({
  appLogPort: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), log: vi.fn() },
}));

import { commitsBehindBase, prepareBranch, refreshBranchOntoBase } from '../pr-creator';

const branch = 'auto-claude/001-x';
let root: string;
let worktree: string;
let collaborator: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();

function commitFile(cwd: string, file: string, content: string, message: string): void {
  writeFileSync(join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-qm', message);
}

/** Someone else lands a commit on main. */
function landOnMain(file: string, content: string): void {
  git(collaborator, 'pull', '-q', 'origin', 'main');
  commitFile(collaborator, file, content, `land ${file}`);
  git(collaborator, 'push', '-q', 'origin', 'main');
}

const prepare = () =>
  prepareBranch({
    projectDir: worktree,
    worktreePath: worktree,
    specId: '001-x',
    branchName: branch,
    baseBranch: 'main',
    title: 'feat: task',
    gitPath: 'git',
  });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pr-refresh-base-'));
  worktree = join(root, 'worktree');
  collaborator = join(root, 'collaborator');
  git(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  git(root, 'clone', '-q', 'origin.git', 'collaborator');
  git(collaborator, 'checkout', '-q', '-b', 'main');
  commitFile(collaborator, 'shared.txt', 'one\ntwo\nthree\n', 'base');
  git(collaborator, 'push', '-q', 'origin', 'main');

  // The task worktree: branched from origin/main once, with one task commit.
  git(root, 'clone', '-q', 'origin.git', 'worktree');
  git(worktree, 'checkout', '-q', '-b', branch, 'origin/main');
  commitFile(worktree, 'task.txt', 'task\n', 'task work');
  warn.mockClear();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('refreshing the task branch onto the latest base (real git)', () => {
  it('merges a base that moved without conflict, then pushes the merged branch', async () => {
    landOnMain('other.txt', 'landed\n');
    const taskCommit = git(worktree, 'rev-parse', 'HEAD');

    const result = await prepare();

    expect(result.ok).toBe(true);
    const originMain = git(worktree, 'rev-parse', 'refs/remotes/origin/main');
    // HEAD now contains both the latest base and the task's own commit.
    git(worktree, 'merge-base', '--is-ancestor', originMain, 'HEAD');
    git(worktree, 'merge-base', '--is-ancestor', taskCommit, 'HEAD');
    // The push carried the merge.
    expect(git(root, '--git-dir', join(root, 'origin.git'), 'rev-parse', `refs/heads/${branch}`)).toBe(
      git(worktree, 'rev-parse', 'HEAD'),
    );
    expect(git(worktree, 'status', '--porcelain')).toBe('');
  });

  it('does not merge when the branch already has the latest base', async () => {
    const before = git(worktree, 'rev-parse', 'HEAD');
    expect(await refreshBranchOntoBase(worktree, 'git', 'main')).toEqual({ status: 'up-to-date' });
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('aborts on conflict, reports BASE_CONFLICT with the files, and pushes nothing', async () => {
    commitFile(worktree, 'shared.txt', 'one\nTASK\nthree\n', 'task edits shared');
    landOnMain('shared.txt', 'one\nBASE\nthree\n');
    const before = git(worktree, 'rev-parse', 'HEAD');

    const result = await prepare();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.result.errorCode).toBe('BASE_CONFLICT');
    expect(result.result.conflictFiles).toEqual(['shared.txt']);
    expect(result.result.error).toContain('shared.txt');
    // The worktree is left as it was: no merge in progress, nothing changed.
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(worktree, 'status', '--porcelain')).toBe('');
    expect(() => git(worktree, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow();
    expect(() => git(root, '--git-dir', join(root, 'origin.git'), 'rev-parse', '-q', '--verify', `refs/heads/${branch}`)).toThrow();
  });

  it('carries on as before when the fetch fails', async () => {
    const before = git(worktree, 'rev-parse', 'HEAD');
    git(worktree, 'remote', 'set-url', 'origin', join(root, 'missing.git'));

    expect(await refreshBranchOntoBase(worktree, 'git', 'main')).toEqual({ status: 'fetch-failed' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Could not fetch origin/main'));
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('does not scan or count the merged-in base commits as task changes', async () => {
    landOnMain('other.txt', 'landed\n');
    expect(await refreshBranchOntoBase(worktree, 'git', 'main')).toEqual({ status: 'merged' });
    expect(git(worktree, 'diff', '--name-only', 'origin/main...HEAD')).toBe('task.txt');
  });
});

describe('commitsBehindBase (real git)', () => {
  it('counts the commits origin/<base> has that the task branch lacks, after fetching', async () => {
    expect(await commitsBehindBase(worktree, 'git', 'main')).toBe(0);
    landOnMain('a.txt', 'a\n');
    landOnMain('b.txt', 'b\n');
    expect(await commitsBehindBase(worktree, 'git', 'main')).toBe(2);
  });

  it('counts against the last fetch when the fetch fails', async () => {
    landOnMain('a.txt', 'a\n');
    git(worktree, 'remote', 'set-url', 'origin', join(root, 'missing.git'));
    expect(await commitsBehindBase(worktree, 'git', 'main')).toBe(0);
    expect(warn).toHaveBeenCalled();
  });
});
