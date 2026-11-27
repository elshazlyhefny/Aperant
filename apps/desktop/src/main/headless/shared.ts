/**
 * zeenha fork: helpers shared by the headless runners (run-task, create-spec).
 * Free of electron imports.
 */

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';

import { getSpecsDir } from '../../shared/constants';
import type { HeadlessConfig } from './config';
import type { HeadlessProject } from './task-store';

export const AUTO_BUILD_PATH = '.auto-claude';

export class HeadlessSetupError extends Error {}

export function findGitRoot(start: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: start,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new HeadlessSetupError(`${start} is not inside a git repository`);
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
