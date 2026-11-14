/**
 * Secret Gate
 * ===========
 *
 * zeenha fork: the secret scanner existed but nothing ran it before a commit or
 * push. This module is the shared piece the commit-side and push-side gates
 * use: it lists the files git is about to record, scans them, and formats a
 * block message that never prints a full secret.
 */

import { execFileSync } from 'node:child_process';

import { maskSecret, scanFiles } from './secret-scanner';
import type { SecretMatch } from './secret-scanner';

const GIT_TIMEOUT_MS = 10_000;

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

function splitNul(output: string): string[] {
  return output.split('\0').filter((entry) => entry.length > 0);
}

/** Resolve the repository top level, or null when cwd is not in a repo. */
export function getRepoRoot(cwd: string): string | null {
  try {
    const top = runGit(cwd, ['rev-parse', '--show-toplevel']).trim();
    return top.length > 0 ? top : null;
  } catch {
    return null;
  }
}

/**
 * Staged files (added, copied, modified, renamed), relative to the repo top
 * level. Returns [] on any git failure.
 */
export function listStagedFiles(cwd: string): string[] {
  try {
    const root = getRepoRoot(cwd);
    if (!root) return [];
    return splitNul(
      runGit(root, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']),
    );
  } catch {
    return [];
  }
}

/**
 * Files changed on HEAD since it diverged from baseRef, relative to the repo
 * top level. Returns [] on any git failure.
 */
export function listBranchFiles(cwd: string, baseRef: string): string[] {
  try {
    const root = getRepoRoot(cwd);
    if (!root) return [];
    return splitNul(
      runGit(root, ['diff', '--name-only', '--diff-filter=ACMR', '-z', `${baseRef}...HEAD`]),
    );
  } catch {
    return [];
  }
}

/**
 * Scan repo-relative files for secrets. Aperant's own `.auto-claude/` task
 * files are never committed, so they are skipped. `.secretsignore` is read
 * from repoRoot.
 */
export function scanChangedFiles(files: string[], repoRoot: string): SecretMatch[] {
  const relevant = files.filter(
    (file) => file !== '.auto-claude' && !file.startsWith('.auto-claude/'),
  );
  if (relevant.length === 0) return [];
  return scanFiles(relevant, repoRoot);
}

/** Build the block message. Secrets are masked; raw line content is never echoed. */
export function formatSecretFindings(
  matches: SecretMatch[],
  context: 'commit' | 'push',
): string {
  const action = context === 'commit' ? 'commit' : 'push';
  const retry =
    context === 'commit'
      ? 'Re-stage the files and retry the commit.'
      : 'Commit the fix and retry the push.';

  const lines: string[] = [
    `SECRET SCAN: ${action} blocked. Potential secrets were found in ${matches.length} place(s):`,
    '',
  ];
  for (const match of matches) {
    lines.push(
      `  ${match.filePath}:${match.lineNumber}  ${match.patternName}  ${maskSecret(match.matchedText)}`,
    );
  }
  lines.push(
    '',
    'To fix:',
    '  1. Move the secret to an environment variable (for example process.env.API_KEY) and read it at runtime.',
    '  2. Add a placeholder for the new variable to .env.example.',
    `  3. ${retry}`,
    '',
    'If a finding is a false positive, add a line to .secretsignore in the repo root.',
    'Each line is one regular expression, matched against the repo-relative path, for example:',
    '  tests/fixtures/',
  );
  return lines.join('\n');
}
