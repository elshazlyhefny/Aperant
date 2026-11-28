/**
 * zeenha fork: what a repository declares about itself in `.aperant.json`.
 *
 *   { "baseBranch": "zeenha", "linkDependencies": ["node_modules"],
 *     "verifyCommands": ["npm run typecheck", "npm test"] }
 *
 * The file is optional, and a project without it behaves as before. It is read
 * from the main checkout, never from a task worktree, so an agent's edit cannot
 * change which folders get linked.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

export const PROJECT_REPO_CONFIG_FILE = '.aperant.json';

export interface ProjectRepoConfig {
  baseBranch?: string;
  linkDependencies: string[];
  /**
   * zeenha fork: shell commands the QA verify gate runs (from the repository
   * root) after QA approves, so an approval means the project's own checks pass.
   */
  verifyCommands?: string[];
}

function isSafeBranchName(value: unknown): value is string {
  return typeof value === 'string' && /^[\w][\w./-]*$/.test(value);
}

function isContainedRelativePath(projectPath: string, value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '' || isAbsolute(value)) return false;
  if (value.split(/[\\/]/).includes('..')) return false;
  return resolve(projectPath, value).startsWith(resolve(projectPath) + sep);
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === 'string' && entry.trim() !== '')
  );
}

export function readProjectRepoConfig(projectPath: string): ProjectRepoConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(projectPath, PROJECT_REPO_CONFIG_FILE), 'utf-8'));
  } catch {
    return { linkDependencies: [] };
  }
  if (typeof raw !== 'object' || raw === null) return { linkDependencies: [] };

  const { baseBranch, linkDependencies, verifyCommands } = raw as Record<string, unknown>;
  return {
    baseBranch: isSafeBranchName(baseBranch) ? baseBranch : undefined,
    linkDependencies: Array.isArray(linkDependencies)
      ? linkDependencies.filter((entry): entry is string =>
          isContainedRelativePath(projectPath, entry),
        )
      : [],
    verifyCommands: isNonEmptyStringArray(verifyCommands) ? verifyCommands : undefined,
  };
}
