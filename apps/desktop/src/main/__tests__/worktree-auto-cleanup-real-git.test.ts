/**
 * zeenha fork: the two git checks that protect unsaved work, against a real
 * repository. cleanupWorktree deletes the directory by hand, so "dirty" must
 * be detected for real, not just in a mock.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../cli-tool-manager', () => ({ getToolPath: (tool: string) => tool }));
vi.mock('../env-utils', () => ({ getAugmentedEnv: () => ({ ...process.env }) }));

import {
  branchTipInRepo,
  commitIsInPullRequest,
  deleteTaskBranch,
  ensureWorktreeDeletable,
  readPullRequestState,
  worktreeHasUncommittedChanges,
  worktreeHeadCommit,
  worktreeIsReal,
} from '../worktree-auto-cleanup';

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

describe('worktreeIsReal', () => {
  it('is true for a repository top level', async () => {
    expect(await worktreeIsReal(repo)).toBe(true);
  });

  it('is false for a leftover folder inside a repository (git would answer for the parent)', async () => {
    const leftover = join(repo, '.auto-claude', 'worktrees', 'tasks', '016-x');
    mkdirSync(join(leftover, 'frontend', '.nuxt'), { recursive: true });
    expect(await worktreeIsReal(leftover)).toBe(false);
  });

  // zeenha fork: a checkout whose .git link points at a pruned admin dir makes
  // git fail. That must not read as "leftover" (which skips the dirty check).
  it('cannot tell (null) when git fails inside the folder', async () => {
    const broken = join(repo, '.auto-claude', 'worktrees', 'tasks', '017-x');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'pruned')}\n`);
    writeFileSync(join(broken, 'work.txt'), 'unsaved\n');
    expect(await worktreeIsReal(broken)).toBeNull();
  });
});

describe('branchTipInRepo', () => {
  it('reads an auto-claude branch and answers null when it does not exist', async () => {
    git('branch', 'auto-claude/016-x');
    expect(await branchTipInRepo(repo, 'auto-claude/016-x')).toBe(git('rev-parse', 'HEAD'));
    expect(await branchTipInRepo(repo, 'auto-claude/999-missing')).toBeNull();
    expect(await branchTipInRepo(repo, 'main')).toBeNull(); // only task branches
  });
});

describe('commitIsInPullRequest', () => {
  let origin: string;
  const PR_URL = 'https://github.com/o/r/pull/7';

  beforeEach(() => {
    origin = mkdtempSync(join(tmpdir(), 'merged-cleanup-origin-'));
    execFileSync('git', ['init', '-q', '--bare', origin]);
    git('remote', 'add', 'origin', origin);
  });

  afterEach(() => {
    rmSync(origin, { recursive: true, force: true });
  });

  it('is true for the PR head and for a commit behind it, false for a commit the PR lacks', async () => {
    const behind = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'a.txt'), 'added on GitHub\n');
    git('commit', '-qam', 'added on GitHub');
    const prHead = git('rev-parse', 'HEAD');
    git('push', '-q', 'origin', `HEAD:refs/pull/7/head`);

    git('checkout', '-q', '-b', 'stray', behind);
    writeFileSync(join(repo, 'c.txt'), 'never pushed\n');
    git('add', '.');
    git('commit', '-qm', 'not in the PR');
    const stray = git('rev-parse', 'HEAD');

    expect(await commitIsInPullRequest(repo, prHead, PR_URL, prHead)).toBe(true);
    expect(await commitIsInPullRequest(repo, behind, PR_URL, prHead)).toBe(true);
    expect(await commitIsInPullRequest(repo, stray, PR_URL, prHead)).toBe(false);
  });

  it('cannot tell (null) when the PR ref cannot be fetched', async () => {
    const head = git('rev-parse', 'HEAD');
    expect(await commitIsInPullRequest(repo, head, 'https://github.com/o/r/pull/99', 'f'.repeat(40))).toBeNull();
  });
});

describe('ensureWorktreeDeletable', () => {
  const tasksDir = () => join(repo, '.auto-claude', 'worktrees', 'tasks');

  it('is ok for a folder the current user owns', async () => {
    const wt = join(tasksDir(), '016-x');
    mkdirSync(join(wt, 'frontend'), { recursive: true });
    writeFileSync(join(wt, 'frontend', 'f.txt'), 'x');
    expect(await ensureWorktreeDeletable(wt, repo)).toEqual({ ok: true });
  });

  it('refuses a folder outside the task worktree directory', async () => {
    expect(await ensureWorktreeDeletable(repo, repo)).toMatchObject({ ok: false });
  });

  const dockerUsable = (() => {
    try {
      execFileSync('docker', ['image', 'inspect', 'alpine:3.20'], { stdio: 'ignore' });
      return process.getuid?.() !== 0;
    } catch {
      return false;
    }
  })();

  it.skipIf(!dockerUsable)('hands root-owned files back (the Docker bind-mount case) so the folder can be deleted', async () => {
    const wt = join(tasksDir(), '020-x');
    mkdirSync(wt, { recursive: true });
    execFileSync('docker', ['run', '--rm', '--network', 'none', '-v', `${wt}:/w`, 'alpine:3.20', 'sh', '-c', 'mkdir -p /w/vendor && touch /w/vendor/autoload.php']);
    expect(statSync(join(wt, 'vendor', 'autoload.php')).uid).toBe(0);

    expect(await ensureWorktreeDeletable(wt, repo)).toEqual({ ok: true });
    expect(statSync(join(wt, 'vendor', 'autoload.php')).uid).toBe(process.getuid?.());
    rmSync(wt, { recursive: true });
    expect(existsSync(wt)).toBe(false);
  });
});

describe('deleteTaskBranch', () => {
  it('deletes an auto-claude branch and refuses anything else', async () => {
    git('branch', 'auto-claude/016-x');
    git('branch', 'feature');
    expect(await deleteTaskBranch(repo, 'auto-claude/016-x')).toEqual({ success: true });
    expect((await deleteTaskBranch(repo, 'feature')).success).toBe(false);
    expect((await deleteTaskBranch(repo, 'main')).success).toBe(false);
    const left = git('branch', '--format=%(refname:short)').split('\n');
    expect(left).not.toContain('auto-claude/016-x');
    expect(left).toContain('feature');
  });
});
