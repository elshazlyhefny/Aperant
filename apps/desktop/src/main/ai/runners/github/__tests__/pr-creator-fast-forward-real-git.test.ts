/**
 * zeenha fork: use real git to prove that the exact lease refuses a moved
 * remote branch without rewriting the follow-up commits in the worktree.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../env-utils', () => ({ getAugmentedEnv: () => ({ ...process.env, LC_ALL: 'C' }) }));

import { pushBranchFastForward } from '../pr-creator';

const branch = 'auto-claude/001-x';
const ref = `refs/heads/${branch}`;
let root: string;
let remote: string;
let worktree: string;
let collaborator: string;
let reviewedSha: string;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

function commit(cwd: string, message: string): string {
  git(
    cwd,
    '-c', 'user.email=t@example.com',
    '-c', 'user.name=Test',
    '-c', 'commit.gpgsign=false',
    'commit', '-qm', message, '--allow-empty',
  );
  return git(cwd, 'rev-parse', 'HEAD');
}

const pushFollowUp = () => pushBranchFastForward(worktree, 'git', branch, reviewedSha);
const remoteTip = () => git(remote, 'rev-parse', ref);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pr-fast-forward-'));
  remote = join(root, 'origin.git');
  worktree = join(root, 'worktree');
  collaborator = join(root, 'collaborator');
  git(root, 'init', '-q', '--bare', '-b', branch, 'origin.git');
  git(root, 'clone', '-q', 'origin.git', 'worktree');
  git(worktree, 'symbolic-ref', 'HEAD', ref);
  reviewedSha = commit(worktree, 'reviewed');
  git(worktree, 'push', '-q', 'origin', `${ref}:${ref}`);
  git(root, 'clone', '-q', 'origin.git', 'collaborator');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('pushBranchFastForward (real git)', () => {
  it('pushes a fast-forward when the remote is still at the exact reviewed revision', async () => {
    const localTip = commit(worktree, 'follow-up');

    expect(await pushFollowUp()).toEqual({ ok: true });
    expect(remoteTip()).toBe(localTip);
  });

  it('rejects a collaborator push and preserves the local HEAD and history', async () => {
    const localTip = commit(worktree, 'follow-up');
    const localHistory = git(worktree, 'rev-list', 'HEAD');
    const collaboratorTip = commit(collaborator, 'independent update');
    git(collaborator, 'push', '-q', 'origin', `${ref}:${ref}`);

    expect(await pushFollowUp()).toMatchObject({ ok: false, stale: true });
    expect(remoteTip()).toBe(collaboratorTip);
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(localTip);
    expect(git(worktree, 'rev-list', 'HEAD')).toBe(localHistory);
  });

  it('rejects a moved remote even when the update would still fast-forward', async () => {
    const collaboratorTip = commit(collaborator, 'independent update');
    git(collaborator, 'push', '-q', 'origin', `${ref}:${ref}`);
    // A bare lease against the freshly fetched tracking ref would pass here.
    git(worktree, 'fetch', '-q', 'origin');
    git(worktree, 'merge', '-q', '--ff-only', `origin/${branch}`);
    const localTip = commit(worktree, 'follow-up');

    expect(await pushFollowUp()).toMatchObject({ ok: false, stale: true });
    expect(remoteTip()).toBe(collaboratorTip);
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(localTip);
  });

  it('rejects a remote branch rewritten to an unrelated commit', async () => {
    const localTip = commit(worktree, 'follow-up');
    git(collaborator, 'checkout', '-q', '--orphan', 'unrelated');
    const collaboratorTip = commit(collaborator, 'unrelated root');
    git(collaborator, 'push', '-q', 'origin', `+HEAD:${ref}`);

    expect(await pushFollowUp()).toMatchObject({ ok: false, stale: true });
    expect(remoteTip()).toBe(collaboratorTip);
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(localTip);
  });

  it('refuses to push a local branch that no longer descends from the reviewed revision', async () => {
    git(worktree, 'checkout', '-q', '--orphan', 'rewritten');
    const localTip = commit(worktree, 'rewritten root');
    git(worktree, 'branch', '-M', branch);

    expect(await pushFollowUp()).toMatchObject({
      ok: false,
      stale: true,
      error: expect.stringContaining('The branch does not descend from the reviewed revision'),
    });
    expect(remoteTip()).toBe(reviewedSha);
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(localTip);
  });

  it.each(['short', 'non-hex'])('refuses a %s expected SHA without pushing', async (kind) => {
    const localTip = commit(worktree, 'follow-up');
    const sha = kind === 'short' ? reviewedSha.slice(0, 12) : 'z'.repeat(40);

    expect(await pushBranchFastForward(worktree, 'git', branch, sha)).toMatchObject({
      ok: false,
      stale: true,
      error: expect.stringContaining('not a full commit SHA'),
    });
    expect(remoteTip()).toBe(reviewedSha);
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(localTip);
  });

  it('does not report an unreachable remote as stale', async () => {
    const localTip = commit(worktree, 'follow-up');
    const movedRemote = join(root, 'moved.git');
    renameSync(remote, movedRemote);

    expect(await pushFollowUp()).toMatchObject({ ok: false, stale: false, error: expect.stringContaining('fatal:') });
    expect(git(movedRemote, 'rev-parse', ref)).toBe(reviewedSha);
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(localTip);
  });
});
