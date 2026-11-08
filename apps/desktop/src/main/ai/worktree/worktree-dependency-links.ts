/**
 * zeenha fork: give a task worktree the dependencies its project declares.
 *
 * A git worktree starts without gitignored folders, so a task's agents could
 * not run a project's tests without a full install per task. Only the folders
 * listed in `.aperant.json` are linked: projects that manage dependencies some
 * other way (zeenha-ai uses Docker volumes) are left alone.
 */

import { execFile } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import { isWindows } from '../../platform';
import { readProjectRepoConfig } from './project-repo-config';

const execFileAsync = promisify(execFile);

function linkEntryExists(path: string): boolean {
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
 * An agent commits with `git add`, so the link has to be ignored. The common
 * `node_modules/` pattern matches directories only, not a link, so a link that
 * .gitignore misses goes in the repository's local exclude file.
 */
async function ensureLinkIsIgnored(worktreePath: string, relPath: string): Promise<void> {
  if (await isGitIgnored(worktreePath, relPath)) return;

  const { stdout } = await execFileAsync('git', ['rev-parse', '--git-path', 'info/exclude'], {
    cwd: worktreePath,
  });
  const excludePath = resolve(worktreePath, stdout.trim());
  mkdirSync(dirname(excludePath), { recursive: true });
  appendFileSync(excludePath, `/${relPath.replace(/\\/g, '/')}\n`);
}

function createLink(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  if (isWindows()) {
    symlinkSync(source, target, 'junction');
  } else {
    // Relative, so the link survives the project folder moving.
    symlinkSync(relative(dirname(target), source), target);
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
    if (!existsSync(source)) continue;

    try {
      if (linkEntryExists(target)) {
        if (existsSync(target)) continue;
        rmSync(target, { force: true }); // A dangling link from an earlier run.
      }
      createLink(source, target);
      await ensureLinkIsIgnored(worktreePath, relPath);
      linked.push(relPath);
    } catch (err: unknown) {
      rmSync(target, { force: true });
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[WorktreeManager] Could not link ${relPath}: ${message}`);
    }
  }

  return linked;
}
