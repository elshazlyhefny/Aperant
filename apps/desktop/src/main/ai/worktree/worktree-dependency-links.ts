/**
 * zeenha fork: give a task worktree the dependencies its project declares.
 *
 * A git worktree starts without gitignored folders, so a task's agents could
 * not run a project's tests without a full install per task. Only the folders
 * listed in `.aperant.json` are linked: projects that manage dependencies some
 * other way (zeenha-ai uses Docker volumes) are left alone.
 */

import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { readProjectRepoConfig } from './project-repo-config';

const execFileAsync = promisify(execFile);

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

async function isGitIgnored(worktreePath: string, relPath: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['check-ignore', '-q', '--', relPath], { cwd: worktreePath });
    return true;
  } catch {
    return false;
  }
}

/**
 * Safe to call again on an existing worktree. Never throws: a task can still
 * run without its links. Returns the paths linked by this call.
 */
export async function linkWorktreeDependencies(
  projectPath: string,
  worktreePath: string,
): Promise<string[]> {
  const linked: string[] = [];

  for (const relPath of readProjectRepoConfig(projectPath).linkDependencies) {
    const source = join(projectPath, relPath);
    const target = join(worktreePath, relPath);
    if (!existsSync(source) || pathEntryExists(target)) continue;

    // An agent commits with `git add`, so an unignored link would land in the PR.
    if (!(await isGitIgnored(worktreePath, relPath))) {
      console.warn(`[WorktreeManager] Not linking ${relPath}: git does not ignore it`);
      continue;
    }

    try {
      mkdirSync(dirname(target), { recursive: true });
      // 'junction' applies on Windows only; other platforms ignore the type.
      symlinkSync(source, target, 'junction');
      linked.push(relPath);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[WorktreeManager] Could not link ${relPath}: ${message}`);
    }
  }

  return linked;
}
