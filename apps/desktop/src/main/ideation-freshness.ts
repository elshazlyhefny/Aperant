/**
 * zeenha fork: ideation reads the project checkout as it is on disk. When that
 * checkout is behind its remote, the agents propose work that has already been
 * merged (2026-10-26: a "translate ~100 toast literals" idea was generated 14
 * hours after the PR that did it merged, from a clone last pulled the day
 * before). Ideation now fetches first and, if the checkout is behind, tells
 * every agent which commits it cannot see and how to read them. The checkout
 * itself is never pulled or changed: it belongs to the person.
 */
import { execFile } from 'node:child_process';

import { getToolPath } from './cli-tool-manager';
import { getIsolatedGitEnv } from './utils/git-isolation';

const FETCH_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 15_000;
/** Commit subjects listed in the prompt; the agent can `git log` the rest. */
export const MAX_LISTED_COMMITS = 40;

export interface UnpulledCommits {
  /** The ref the checkout is compared with, e.g. `origin/main`. */
  upstream: string;
  count: number;
  /** `<short sha> <subject>`, newest first, at most MAX_LISTED_COMMITS. */
  subjects: string[];
}

function git(args: string[], cwd: string, timeout = GIT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      getToolPath('git'),
      args,
      { cwd, env: { ...getIsolatedGitEnv(), GIT_TERMINAL_PROMPT: '0' }, timeout, maxBuffer: 1024 * 1024, encoding: 'utf-8' },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
    );
  });
}

async function resolveUpstream(projectDir: string): Promise<string | null> {
  for (const ref of ['@{upstream}', 'origin/HEAD']) {
    try {
      const name = (await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', ref], projectDir)).trim();
      if (name && name !== ref) return name;
    } catch {
      // try the next one
    }
  }
  return null;
}

/**
 * Commits on the checkout's upstream (else `origin/HEAD`) that HEAD lacks, after
 * a fetch. Null when the checkout is current or nothing can be compared; a
 * failed fetch still compares against the last fetched state.
 */
export async function findUnpulledCommits(projectDir: string): Promise<UnpulledCommits | null> {
  try {
    await git(['fetch', '--quiet', '--no-tags'], projectDir, FETCH_TIMEOUT_MS);
  } catch {
    // offline or no remote: compare with what was fetched last
  }
  const upstream = await resolveUpstream(projectDir);
  if (!upstream) return null;
  try {
    const count = Number.parseInt((await git(['rev-list', '--count', `HEAD..${upstream}`], projectDir)).trim(), 10);
    if (!Number.isFinite(count) || count <= 0) return null;
    const log = await git(['log', '--format=%h %s', `-n${MAX_LISTED_COMMITS}`, `HEAD..${upstream}`], projectDir);
    return { upstream, count, subjects: log.split('\n').filter(Boolean) };
  } catch {
    return null;
  }
}

export type CheckoutUpdate =
  /** Fast-forwarded `from`..`to` (short shas) onto `upstream`. */
  | { kind: 'pulled'; upstream: string; count: number; from: string; to: string }
  /** Nothing to pull (or nothing to compare with). */
  | { kind: 'current' }
  /** Behind, but left as it is; `reason` says why. */
  | { kind: 'behind'; reason: string; unpulled: UnpulledCommits };

/**
 * zeenha fork: the roadmap brings its checkout up to date before it reads it
 * (2026-11-05: discovery ran on a clone 66 commits behind and proposed work
 * that had merged that day). Only ever a fast-forward of the branch onto its
 * OWN upstream, and only when no tracked file is modified: anything else is
 * left untouched and reported, so the agents can be told what they cannot see.
 * `.auto-claude/` is Aperant's own state and does not count as a change.
 */
export async function fastForwardCheckout(projectDir: string): Promise<CheckoutUpdate> {
  const unpulled = await findUnpulledCommits(projectDir); // fetches
  if (!unpulled) return { kind: 'current' };
  const behind = (reason: string): CheckoutUpdate => ({ kind: 'behind', reason, unpulled });

  let tracking = '';
  try {
    tracking = (await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], projectDir)).trim();
  } catch {
    // detached HEAD or no tracking branch
  }
  if (tracking !== unpulled.upstream) return behind('the current branch does not track a remote branch');

  try {
    const dirty = await git(['status', '--porcelain', '--untracked-files=no', '--', '.', ':(exclude).auto-claude'], projectDir);
    if (dirty.trim()) return behind('it has uncommitted changes');
  } catch {
    return behind('its status could not be read');
  }
  try {
    const from = (await git(['rev-parse', '--short', 'HEAD'], projectDir)).trim();
    await git(['merge', '--ff-only', '--quiet', unpulled.upstream], projectDir, FETCH_TIMEOUT_MS);
    const to = (await git(['rev-parse', '--short', 'HEAD'], projectDir)).trim();
    return { kind: 'pulled', upstream: unpulled.upstream, count: unpulled.count, from, to };
  } catch {
    return behind('it cannot be fast-forwarded (it has local commits, or untracked files are in the way)');
  }
}

/** One line for the run log, or null when there is nothing to say. */
export function checkoutUpdateLog(update: CheckoutUpdate): string | null {
  if (update.kind === 'pulled') {
    return `Updated the project checkout: fast-forwarded ${update.count} commit(s) from ${update.upstream} (${update.from} → ${update.to}).\n`;
  }
  if (update.kind === 'behind') {
    return `The project checkout is ${update.unpulled.count} commit(s) behind ${update.unpulled.upstream} and was NOT updated: ${update.reason}. The agents are told which commits they cannot see; pull it for the most accurate result.\n`;
  }
  return null;
}

/** The prompt section that tells an ideation agent what its checkout is missing. */
export function unpulledCommitsNote({ upstream, count, subjects }: UnpulledCommits): string {
  const more = count > subjects.length ? `\n- …and ${count - subjects.length} older ones` : '';
  return [
    `**Checkout is behind**: the project files are ${count} commit${count === 1 ? '' : 's'} behind \`${upstream}\`.`,
    'Those commits are already merged, but the files you read do not contain them:',
    subjects.map((s) => `- ${s}`).join('\n') + more,
    `Before you propose an idea, make sure these commits have not already done it: \`git log HEAD..${upstream} -- <path>\` lists the ones that touch a file, and \`git show ${upstream}:<path>\` shows the merged version. Describe the code as it is on \`${upstream}\`, not as the checkout shows it.`,
  ].join('\n');
}
