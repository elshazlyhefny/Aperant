/**
 * zeenha fork: helpers shared by the headless runners (run-task, create-spec).
 * Free of electron imports.
 */

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';

import { getSpecsDir } from '../../shared/constants';
import { LEGACY_WORKTREE_DIR, TASK_WORKTREE_DIR } from '../worktree-paths';
import type { HeadlessConfig } from './config';
import type { HeadlessProject } from './task-store';

export const AUTO_BUILD_PATH = '.auto-claude';

export class HeadlessSetupError extends Error {}

export function findGitRoot(start: string): string {
  try {
    // zeenha fork: Git for Windows prints C:/Users/..., so normalize to the
    // platform's separators. Otherwise the project path differs from every
    // path.join() result built from it, and from the desktop app's paths.
    return path.normalize(
      execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: start,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    );
  } catch {
    throw new HeadlessSetupError(`${start} is not inside a git repository`);
  }
}

/** zeenha fork: share receipt storage with desktop without changing the build checkout. */
export function resolveDeliveryReceiptRoot(checkoutRoot: string): string | undefined {
  const worktreeDirs = [TASK_WORKTREE_DIR, LEGACY_WORKTREE_DIR];
  try {
    let root = realpathSync(checkoutRoot);
    if (!worktreeDirs.some((dir) => path.dirname(root).endsWith(path.sep + path.normalize(dir)))) {
      return root;
    }

    // Require Git to recognize the enclosing project as a checkout of the same
    // repo. A standalone repository under a similarly named folder stays separate.
    const worktrees = execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).split('\0\0').flatMap((record) => {
      const [entry, ...fields] = record.split('\0');
      return entry.startsWith('worktree ') && !fields.includes('bare')
        ? [path.normalize(entry.slice('worktree '.length))]
        : [];
    });
    if (!worktrees.includes(root)) return undefined;

    // A run in a task worktree can itself create a nested task worktree.
    for (;;) {
      const parent = worktrees.find((candidate) =>
        worktreeDirs.some((dir) => path.dirname(root) === path.join(candidate, dir)),
      );
      if (!parent) return root;
      root = parent;
    }
  } catch {
    // Do not fall back to a worktree-local file when Git metadata is unavailable.
    return undefined;
  }
}

/** Resolve the project for a headless command; same id format as `serve`. */
export function resolveHeadlessProject(projectPath?: string): HeadlessProject {
  const root = findGitRoot(path.resolve(projectPath ?? process.cwd()));
  return { id: `headless:${realpathSync(root)}`, path: root, autoBuildPath: AUTO_BUILD_PATH };
}

/** zeenha fork: resolve a spec in the selected checkout, including task worktrees. */
export function resolveHeadlessSpec(projectRoot: string, spec: string): { specId: string; specDir: string } {
  const specsDir = path.join(projectRoot, getSpecsDir(AUTO_BUILD_PATH));
  const looksLikePath = spec.includes('/') || spec.includes(path.sep);
  if (!looksLikePath) {
    return { specId: spec, specDir: path.join(specsDir, spec) };
  }
  const specDir = path.resolve(spec);
  const specId = path.basename(specDir);
  if (path.resolve(specsDir, specId) !== specDir) {
    throw new HeadlessSetupError(`Spec directory ${specDir} must be inside ${specsDir}`);
  }
  return { specId, specDir };
}

export function providerPhaseModels(config: HeadlessConfig) {
  return (provider: string): Record<string, string> | undefined => {
    const entry = config.providerAgentConfig?.[provider] as { customPhaseModels?: Record<string, string> } | undefined;
    return entry?.customPhaseModels;
  };
}
