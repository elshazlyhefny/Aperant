/**
 * zeenha fork: Bitbucket PR checkout. Real git: a bare "origin" with a feature
 * branch (Bitbucket has no refs/pull ref), and the project clone on main.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../cli-tool-manager', () => ({ getToolPath: () => 'git' }));

import { bbReviewRef, PR_REVIEW_DIR, prepareBitbucketReviewCheckout } from '../pr-review-checkout';

let root: string;
let project: string;
let author: string;
let featureSha: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf-8' }).trim();

const input = (over: Record<string, unknown> = {}) => ({
  prId: 5,
  sourceBranch: 'feature/escape',
  headSha: featureSha,
  configuredRepository: 'ws/repo',
  ...over,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pr-review-checkout-bb-'));
  git(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  git(root, 'clone', '-q', 'origin.git', 'author');
  author = join(root, 'author');
  writeFileSync(join(author, 'app.php'), 'return $unsafe;\n');
  git(author, 'add', '-A');
  git(author, 'commit', '-qm', 'base');
  git(author, 'push', '-q', 'origin', 'HEAD:main');
  git(author, 'checkout', '-q', '-b', 'feature/escape');
  writeFileSync(join(author, 'app.php'), 'return e($unsafe);\n');
  git(author, 'commit', '-qam', 'escape the output');
  featureSha = git(author, 'rev-parse', 'HEAD');
  git(author, 'push', '-q', 'origin', 'feature/escape');
  git(root, 'clone', '-q', 'origin.git', 'project');
  project = join(root, 'project');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('prepareBitbucketReviewCheckout', () => {
  it('checks out the PR head commit', async () => {
    const checkout = await prepareBitbucketReviewCheckout(project, input());
    expect(checkout.kind).toBe('pr-head');
    if (checkout.kind !== 'pr-head') return;
    expect(checkout.sha).toBe(featureSha);
    expect(checkout.dir.startsWith(join(project, PR_REVIEW_DIR))).toBe(true);
    expect(readFileSync(join(checkout.dir, 'app.php'), 'utf-8')).toBe('return e($unsafe);\n');
    expect(readFileSync(join(project, 'app.php'), 'utf-8')).toBe('return $unsafe;\n');
    await checkout.cleanup();
  });

  it('removes the worktree and the private ref on cleanup', async () => {
    const checkout = await prepareBitbucketReviewCheckout(project, input());
    if (checkout.kind !== 'pr-head') throw new Error('expected a checkout');
    await checkout.cleanup();
    expect(existsSync(checkout.dir)).toBe(false);
    expect(git(project, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(() => git(project, 'rev-parse', '--verify', bbReviewRef(5))).toThrow();
    expect(readdirSync(join(project, PR_REVIEW_DIR))).toEqual([]);
  });

  it('never reviews a different commit when the branch moved after the API read', async () => {
    writeFileSync(join(author, 'app.php'), 'moved\n');
    git(author, 'commit', '-qam', 'moved on');
    git(author, 'push', '-q', 'origin', 'feature/escape');
    const checkout = await prepareBitbucketReviewCheckout(project, input());
    if (checkout.kind === 'pr-head') {
      // fetched by sha: still the API head, never the moved branch tip
      expect(checkout.sha).toBe(featureSha);
      expect(readFileSync(join(checkout.dir, 'app.php'), 'utf-8')).toBe('return e($unsafe);\n');
      await checkout.cleanup();
    } else {
      expect(checkout.reason).toMatch(/not the reviewed commit|could not fetch/);
    }
  });

  it('falls back to base for an unusable branch name', async () => {
    for (const sourceBranch of ['', '-evil', 'a..b', 'a b', 'a:b', 'a~1', 'a^', 'a?', 'a*', 'a[', 'a\\b', 'a\nb']) {
      expect(await prepareBitbucketReviewCheckout(project, input({ sourceBranch }))).toMatchObject({ kind: 'base' });
    }
  });

  it('falls back to base for an invalid head sha', async () => {
    expect(await prepareBitbucketReviewCheckout(project, input({ headSha: 'abc' }))).toMatchObject({ kind: 'base' });
  });

  it('falls back to base for a fork PR without fetching', async () => {
    const checkout = await prepareBitbucketReviewCheckout(project, input({ sourceRepository: 'someone/fork' }));
    expect(checkout).toMatchObject({ kind: 'base' });
    expect(checkout.kind === 'base' && checkout.reason).toMatch(/fork/);
    expect(() => git(project, 'rev-parse', '--verify', bbReviewRef(5))).toThrow();
  });
});
