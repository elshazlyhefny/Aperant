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
 * zeenha fork: GitLab exposes every merge request's head as
 * `refs/merge-requests/<iid>/head`, the same way GitHub exposes `refs/pull/<N>/head`.
 * The private ref is namespaced `mr-<iid>` so a PR and an MR with the same
 * number never collide.
 */
export function mrReviewRef(mrIid: number): string {
  return `refs/aperant/pr-review/mr-${mrIid}`;
}

/**
 * zeenha fork: Bitbucket Cloud has no `refs/pull`-style ref, so its private ref
 * is fetched from the source branch (or by sha) instead.
 */
export function bbReviewRef(prId: number): string {
  return `refs/aperant/pr-review/bb-${prId}`;
}

interface CheckoutSpec {
  number: number;
  /** Refspecs tried in order; the first whose fetch succeeds (and matches expectedSha) wins. */
  fetchAttempts: string[];
  /** When set, a fetched commit with a different sha is rejected. */
  expectedSha?: string;
  privateRef: string;
  label: 'PR' | 'MR';
  dirPrefix: string;
}

async function prepareReviewCheckout(
  projectDir: string,
  remote: string,
  { number, fetchAttempts, expectedSha, privateRef: ref, label, dirPrefix }: CheckoutSpec,
): Promise<PRReviewCheckout> {
  if (!Number.isInteger(number) || number <= 0) return { kind: 'base', reason: `invalid ${label} number ${number}` };

  let sha = '';
  let failure = `could not fetch the ${label} head`;
  for (const refspec of fetchAttempts) {
    try {
      await git(['fetch', '--quiet', '--no-tags', remote, refspec], projectDir, FETCH_TIMEOUT_MS);
    } catch (error) {
      failure = `could not fetch the ${label} head (${(error as Error).message.split('\n')[0]})`;
      continue;
    }
    let fetched: string;
    try {
      fetched = (await git(['rev-parse', '--verify', `${ref}^{commit}`], projectDir)).trim();
    } catch {
      failure = `the fetched ${label} head is not a commit`;
      continue;
    }
    if (expectedSha && fetched.toLowerCase() !== expectedSha.toLowerCase()) {
      failure = `the fetched ${label} head (${fetched.slice(0, 12)}) is not the reviewed commit (${expectedSha.slice(0, 12)})`;
      continue;
    }
    sha = fetched;
    break;
  }
  if (!sha) {
    try {
      await git(['update-ref', '-d', ref], projectDir);
    } catch {
      // nothing was fetched
    }
    return { kind: 'base', reason: failure };
  }

  const root = path.join(projectDir, PR_REVIEW_DIR);
  mkdirSync(root, { recursive: true });
  const dir = path.join(root, `${dirPrefix}-${number}-${sha.slice(0, 8)}-${Date.now().toString(36)}`);

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
      return { kind: 'base', reason: `the review worktree did not check out the ${label} head` };
    }
  } catch (error) {
    await cleanup();
    return { kind: 'base', reason: `could not create the review worktree (${(error as Error).message.split('\n')[0]})` };
  }

  return { kind: 'pr-head', dir, sha, cleanup };
}

/**
 * Check out PR `prNumber`'s head for review. Never throws: when it cannot, the
 * review falls back to the project checkout and `reason` says why.
 */
export function preparePRReviewCheckout(projectDir: string, prNumber: number, remote = 'origin'): Promise<PRReviewCheckout> {
  return prepareReviewCheckout(projectDir, remote, {
    number: prNumber,
    fetchAttempts: [`+refs/pull/${prNumber}/head:${prReviewRef(prNumber)}`],
    privateRef: prReviewRef(prNumber),
    label: 'PR',
    dirPrefix: 'pr',
  });
}

/** Same as {@link preparePRReviewCheckout} for a GitLab merge request (by iid). */
export function prepareMRReviewCheckout(projectDir: string, mrIid: number, remote = 'origin'): Promise<PRReviewCheckout> {
  return prepareReviewCheckout(projectDir, remote, {
    number: mrIid,
    fetchAttempts: [`+refs/merge-requests/${mrIid}/head:${mrReviewRef(mrIid)}`],
    privateRef: mrReviewRef(mrIid),
    label: 'MR',
    dirPrefix: 'mr',
  });
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is rejected
const UNSAFE_BRANCH = /[\x00-\x20\x7f:~^?*[\\]/;

function isSafeBranchName(branch: string): boolean {
  return branch.length > 0 && !branch.startsWith('-') && !branch.includes('..') && !UNSAFE_BRANCH.test(branch);
}

export interface BitbucketCheckoutInput {
  prId: number;
  sourceBranch: string;
  headSha: string;
  /** Full name of the repository the PR branch lives in, when the API reports one. */
  sourceRepository?: string;
  configuredRepository: string;
}

/**
 * Check out a Bitbucket Cloud PR's head. Fetches only from the configured remote
 * (no credentials in argv or URLs); a fork PR or a head that moved after the API
 * read falls back to the base checkout rather than reviewing a different commit.
 */
export function prepareBitbucketReviewCheckout(
  projectDir: string,
  { prId, sourceBranch, headSha, sourceRepository, configuredRepository }: BitbucketCheckoutInput,
  remote = 'origin',
): Promise<PRReviewCheckout> {
  if (!isSafeBranchName(sourceBranch)) {
    return Promise.resolve({ kind: 'base', reason: 'the PR source branch name is not usable' });
  }
  if (!/^[0-9a-f]{40}$/i.test(headSha)) {
    return Promise.resolve({ kind: 'base', reason: 'the PR head commit sha is not valid' });
  }
  if (sourceRepository && sourceRepository.toLowerCase() !== configuredRepository.toLowerCase()) {
    return Promise.resolve({
      kind: 'base',
      reason: 'the PR comes from a fork, which is not fetched (no credentials are sent to other repositories)',
    });
  }
  const privateRef = bbReviewRef(prId);
  return prepareReviewCheckout(projectDir, remote, {
    number: prId,
    fetchAttempts: [`+refs/heads/${sourceBranch}:${privateRef}`, `+${headSha}:${privateRef}`],
    expectedSha: headSha,
    privateRef,
    label: 'PR',
    dirPrefix: 'bb',
  });
}

/** What the reviewers are told about the files their tools read. */
export function checkoutNoteFor(checkout: PRReviewCheckout, baseBranch: string, subject: 'PR' | 'MR' = 'PR'): string {
  if (checkout.kind === 'pr-head') {
    return `## Files you can read\nYour working directory is a checkout of this ${subject}'s head commit (${checkout.sha.slice(0, 12)}): files you read show the code WITH the ${subject}'s changes applied, so you can read a changed file in full and confirm a finding against the line as the ${subject} leaves it.`;
  }
  return `## Files you can read\nWARNING: the ${subject} could not be checked out (${checkout.reason}). Files you read are the BASE branch (${baseBranch}), WITHOUT this ${subject}'s changes. Judge changed code from the diff above, and never confirm or dismiss a finding about a changed line from what the file on disk shows.`;
}
