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
