/**
 * zeenha fork: MR reviewers read the MR's own code. Real git: a bare "origin"
 * that has `refs/merge-requests/7/head` (GitLab's MR ref), and the project clone on main.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../cli-tool-manager', () => ({ getToolPath: () => 'git' }));

import {
  checkoutNoteFor,
  mrReviewRef,
  PR_REVIEW_DIR,
  prepareMRReviewCheckout,
  preparePRReviewCheckout,
  prReviewRef,
} from '../../github/pr-review-checkout';

let root: string;
let project: string;
let mrSha: string;
let prSha: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf-8' }).trim();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mr-review-checkout-'));
  git(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  git(root, 'clone', '-q', 'origin.git', 'author');
  const author = join(root, 'author');
  writeFileSync(join(author, 'app.php'), 'return $unsafe;\n');
  git(author, 'add', '-A');
  git(author, 'commit', '-qm', 'base');
  git(author, 'push', '-q', 'origin', 'HEAD:main');
  writeFileSync(join(author, 'app.php'), 'return e($unsafe);\n');
  git(author, 'commit', '-qam', 'MR !7: escape the output');
  mrSha = git(author, 'rev-parse', 'HEAD');
  git(author, 'push', '-q', 'origin', 'HEAD:refs/merge-requests/7/head');
  writeFileSync(join(author, 'app.php'), 'return htmlspecialchars($unsafe);\n');
  git(author, 'commit', '-qam', 'PR #7: another fix');
  prSha = git(author, 'rev-parse', 'HEAD');
  git(author, 'push', '-q', 'origin', 'HEAD:refs/pull/7/head');
  git(root, 'clone', '-q', 'origin.git', 'project');
  project = join(root, 'project');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('prepareMRReviewCheckout', () => {
  it('checks out the MR head, detached, leaving the project checkout alone', async () => {
    const checkout = await prepareMRReviewCheckout(project, 7);

    expect(checkout.kind).toBe('pr-head');
    if (checkout.kind !== 'pr-head') return;
    expect(checkout.sha).toBe(mrSha);
    expect(checkout.dir.startsWith(join(project, PR_REVIEW_DIR))).toBe(true);
    expect(readFileSync(join(checkout.dir, 'app.php'), 'utf-8')).toBe('return e($unsafe);\n');
    expect(git(checkout.dir, 'rev-parse', 'HEAD')).toBe(mrSha);
    expect(git(checkout.dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    expect(readFileSync(join(project, 'app.php'), 'utf-8')).toBe('return $unsafe;\n');
    expect(git(project, 'branch', '--format=%(refname:short)')).toBe('main');

    await checkout.cleanup();
  });

  it('removes the worktree and the private ref on cleanup', async () => {
    const checkout = await prepareMRReviewCheckout(project, 7);
    if (checkout.kind !== 'pr-head') throw new Error('expected a checkout');
    writeFileSync(join(checkout.dir, 'scratch.txt'), 'left by an agent');

    await checkout.cleanup();

    expect(existsSync(checkout.dir)).toBe(false);
    expect(git(project, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(() => git(project, 'rev-parse', '--verify', mrReviewRef(7))).toThrow();
    expect(readdirSync(join(project, PR_REVIEW_DIR))).toEqual([]);
  });

  it('falls back to the base branch with a reason when the MR does not exist', async () => {
    const checkout = await prepareMRReviewCheckout(project, 999);
    expect(checkout).toMatchObject({ kind: 'base' });
    expect(checkout.kind === 'base' && checkout.reason).toMatch(/could not fetch the MR head/);
    expect(existsSync(join(project, PR_REVIEW_DIR)) ? readdirSync(join(project, PR_REVIEW_DIR)) : []).toEqual([]);
  });

  it('refuses an invalid MR iid before running git', async () => {
    expect(await prepareMRReviewCheckout(project, Number.NaN)).toMatchObject({ kind: 'base', reason: 'invalid MR number NaN' });
    expect(await prepareMRReviewCheckout(project, 0)).toMatchObject({ kind: 'base', reason: 'invalid MR number 0' });
  });

  it('does not collide with a PR of the same number', async () => {
    const mr = await prepareMRReviewCheckout(project, 7);
    const pr = await preparePRReviewCheckout(project, 7);
    if (mr.kind !== 'pr-head' || pr.kind !== 'pr-head') throw new Error('expected checkouts');
    expect(mr.sha).toBe(mrSha);
    expect(pr.sha).toBe(prSha);
    expect(mr.dir).not.toBe(pr.dir);
    expect(mrReviewRef(7)).not.toBe(prReviewRef(7));

    await mr.cleanup();
    expect(existsSync(pr.dir)).toBe(true);
    expect(git(project, 'rev-parse', '--verify', prReviewRef(7))).toBe(prSha);
    await pr.cleanup();
  });
});

describe('checkoutNoteFor with an MR subject', () => {
  it('speaks of the MR', () => {
    const ok = checkoutNoteFor({ kind: 'pr-head', dir: '/x', sha: 'abcdef1234567890', cleanup: async () => undefined }, 'main', 'MR');
    expect(ok).toContain("checkout of this MR's head commit (abcdef123456)");
    const base = checkoutNoteFor({ kind: 'base', reason: 'offline' }, 'main', 'MR');
    expect(base).toContain('the MR could not be checked out (offline)');
    expect(base).toContain("WITHOUT this MR's changes");
  });
});
