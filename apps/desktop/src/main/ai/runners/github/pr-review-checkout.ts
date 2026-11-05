/**
 * zeenha fork: PR reviewers read the PR's own code.
 *
 * Upstream gave the review specialists the diff as text plus Read/Grep tools
 * bound to the project checkout, which is the BASE branch: every "re-read the
 * actual code to confirm" read the code as it was before the PR. The review now
 * runs in a detached worktree of `refs/pull/<N>/head` under
 * `.auto-claude/pr-review/`, removed when the review ends. Detached: no branch
 * is created, nothing can be pushed from it.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { getToolPath } from '../../../cli-tool-manager';
import { getIsolatedGitEnv } from '../../../utils/git-isolation';

const FETCH_TIMEOUT_MS = 120_000;
const GIT_TIMEOUT_MS = 60_000;

export const PR_REVIEW_DIR = path.join('.auto-claude', 'pr-review');

export type PRReviewCheckout =
  | { kind: 'pr-head'; dir: string; sha: string; cleanup: () => Promise<void> }
  | { kind: 'base'; reason: string };

function git(args: string[], cwd: string, timeout = GIT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      getToolPath('git'),
      args,
      { cwd, env: { ...getIsolatedGitEnv(), GIT_TERMINAL_PROMPT: '0' }, timeout, maxBuffer: 4 * 1024 * 1024, encoding: 'utf-8' },
      (error, stdout, stderr) => (error ? reject(new Error(String(stderr || error.message).trim())) : resolve(String(stdout))),
    );
  });
}

/** The private ref the PR head is fetched into (not a branch). */
export function prReviewRef(prNumber: number): string {
  return `refs/aperant/pr-review/pr-${prNumber}`;
}

/**
 * Check out PR `prNumber`'s head for review. Never throws: when it cannot, the
 * review falls back to the project checkout and `reason` says why.
 */
export async function preparePRReviewCheckout(projectDir: string, prNumber: number, remote = 'origin'): Promise<PRReviewCheckout> {
  if (!Number.isInteger(prNumber) || prNumber <= 0) return { kind: 'base', reason: `invalid PR number ${prNumber}` };
  const ref = prReviewRef(prNumber);
  try {
    await git(['fetch', '--quiet', '--no-tags', remote, `+refs/pull/${prNumber}/head:${ref}`], projectDir, FETCH_TIMEOUT_MS);
  } catch (error) {
    return { kind: 'base', reason: `could not fetch the PR head (${(error as Error).message.split('\n')[0]})` };
  }

  let sha: string;
  try {
    sha = (await git(['rev-parse', '--verify', `${ref}^{commit}`], projectDir)).trim();
  } catch {
    return { kind: 'base', reason: 'the fetched PR head is not a commit' };
  }

  const root = path.join(projectDir, PR_REVIEW_DIR);
  mkdirSync(root, { recursive: true });
  const dir = path.join(root, `pr-${prNumber}-${sha.slice(0, 8)}-${Date.now().toString(36)}`);

  const cleanup = async () => {
    // `worktree remove` refuses a folder git does not list as a worktree, so it
    // can never delete anything but the checkout made here.
    try {
      await git(['worktree', 'remove', '--force', dir], projectDir);
    } catch {
      // already gone, or never registered
    }
    try {
      await git(['update-ref', '-d', ref], projectDir);
    } catch {
      // another review of the same PR may have removed it
    }
  };

  try {
    await git(['worktree', 'add', '--detach', '--quiet', dir, sha], projectDir);
    // Any git call inside a worktree folder must first confirm the folder is
    // its own top level; a half-made one answers for the parent repository.
    const top = (await git(['rev-parse', '--show-toplevel'], dir)).trim();
    const head = (await git(['rev-parse', 'HEAD'], dir)).trim();
    if (!existsSync(dir) || realpathSync(top) !== realpathSync(dir) || head !== sha) {
      await cleanup();
      return { kind: 'base', reason: 'the review worktree did not check out the PR head' };
    }
  } catch (error) {
    await cleanup();
    return { kind: 'base', reason: `could not create the review worktree (${(error as Error).message.split('\n')[0]})` };
  }

  return { kind: 'pr-head', dir, sha, cleanup };
}

/** What the reviewers are told about the files their tools read. */
export function checkoutNoteFor(checkout: PRReviewCheckout, baseBranch: string): string {
  if (checkout.kind === 'pr-head') {
    return `## Files you can read\nYour working directory is a checkout of this PR's head commit (${checkout.sha.slice(0, 12)}): files you read show the code WITH the PR's changes applied, so you can read a changed file in full and confirm a finding against the line as the PR leaves it.`;
  }
  return `## Files you can read\nWARNING: the PR could not be checked out (${checkout.reason}). Files you read are the BASE branch (${baseBranch}), WITHOUT this PR's changes. Judge changed code from the diff above, and never confirm or dismiss a finding about a changed line from what the file on disk shows.`;
}
