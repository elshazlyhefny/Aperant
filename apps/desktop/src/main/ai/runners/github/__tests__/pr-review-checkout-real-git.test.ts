/**
 * zeenha fork: PR reviewers read the PR's own code. Real git: a bare "origin"
 * that has `refs/pull/7/head` (GitHub's PR ref), and the project clone on main.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../cli-tool-manager', () => ({ getToolPath: () => 'git' }));

import { checkoutNoteFor, PR_REVIEW_DIR, preparePRReviewCheckout, prReviewRef } from '../pr-review-checkout';

let root: string;
let project: string;
let prSha: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf-8' }).trim();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pr-review-checkout-'));
  git(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  git(root, 'clone', '-q', 'origin.git', 'author');
  const author = join(root, 'author');
  writeFileSync(join(author, 'app.php'), 'return $unsafe;\n');
  git(author, 'add', '-A');
  git(author, 'commit', '-qm', 'base');
  git(author, 'push', '-q', 'origin', 'HEAD:main');
  writeFileSync(join(author, 'app.php'), 'return e($unsafe);\n');
  git(author, 'commit', '-qam', 'PR #7: escape the output');
  prSha = git(author, 'rev-parse', 'HEAD');
  git(author, 'push', '-q', 'origin', 'HEAD:refs/pull/7/head');
  git(root, 'clone', '-q', 'origin.git', 'project');
  project = join(root, 'project');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('preparePRReviewCheckout', () => {
  it("checks out the PR head, so a reviewer reads the file as the PR leaves it", async () => {
    const checkout = await preparePRReviewCheckout(project, 7);

    expect(checkout.kind).toBe('pr-head');
    if (checkout.kind !== 'pr-head') return;
    expect(checkout.sha).toBe(prSha);
    expect(checkout.dir.startsWith(join(project, PR_REVIEW_DIR))).toBe(true);
    expect(readFileSync(join(checkout.dir, 'app.php'), 'utf-8')).toBe('return e($unsafe);\n');
    // the project checkout itself is untouched, and no branch was created
    expect(readFileSync(join(project, 'app.php'), 'utf-8')).toBe('return $unsafe;\n');
    expect(git(project, 'branch', '--format=%(refname:short)')).toBe('main');
    expect(git(checkout.dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD'); // detached

    await checkout.cleanup();
  });

  it('removes the worktree, its registration and the fetched ref on cleanup', async () => {
    const checkout = await preparePRReviewCheckout(project, 7);
    if (checkout.kind !== 'pr-head') throw new Error('expected a checkout');
    // a reviewer (the finding validator has Write) may leave changes behind
    writeFileSync(join(checkout.dir, 'scratch.txt'), 'left by an agent');
    writeFileSync(join(checkout.dir, 'app.php'), 'edited');

    await checkout.cleanup();

    expect(existsSync(checkout.dir)).toBe(false);
    expect(git(project, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(() => git(project, 'rev-parse', '--verify', prReviewRef(7))).toThrow();
    expect(readdirSync(join(project, PR_REVIEW_DIR))).toEqual([]);
  });

  it('gives two reviews of the same PR their own folders', async () => {
    const a = await preparePRReviewCheckout(project, 7);
    await new Promise((r) => setTimeout(r, 5));
    const b = await preparePRReviewCheckout(project, 7);
    if (a.kind !== 'pr-head' || b.kind !== 'pr-head') throw new Error('expected checkouts');
    expect(a.dir).not.toBe(b.dir);
    await a.cleanup();
    expect(existsSync(b.dir)).toBe(true);
    await b.cleanup();
  });

  it('falls back to the base branch with a reason when the PR does not exist', async () => {
    const checkout = await preparePRReviewCheckout(project, 999);
    expect(checkout).toMatchObject({ kind: 'base' });
    expect(checkout.kind === 'base' && checkout.reason).toMatch(/could not fetch the PR head/);
    expect(existsSync(join(project, PR_REVIEW_DIR)) ? readdirSync(join(project, PR_REVIEW_DIR)) : []).toEqual([]);
  });

  it('refuses a non-numeric PR number before running git', async () => {
    expect(await preparePRReviewCheckout(project, Number.NaN)).toMatchObject({ kind: 'base', reason: 'invalid PR number NaN' });
  });
});

describe('checkoutNoteFor', () => {
  it('tells the reviewers which code their tools show', () => {
    expect(checkoutNoteFor({ kind: 'pr-head', dir: '/x', sha: 'abcdef1234567890', cleanup: async () => undefined }, 'main'))
      .toContain("checkout of this PR's head commit (abcdef123456)");
    const base = checkoutNoteFor({ kind: 'base', reason: 'offline' }, 'main');
    expect(base).toContain('the PR could not be checked out (offline)');
    expect(base).toContain('BASE branch (main), WITHOUT this PR');
  });
});
