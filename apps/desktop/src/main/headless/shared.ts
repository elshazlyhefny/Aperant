/**
 * zeenha fork: helpers shared by the headless runners (run-task, create-spec).
 * Free of electron imports.
 */

import { execFileSync } from 'node:child_process';

import type { HeadlessConfig } from './config';

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

export function providerPhaseModels(config: HeadlessConfig) {
  return (provider: string): Record<string, string> | undefined => {
    const entry = config.providerAgentConfig?.[provider] as { customPhaseModels?: Record<string, string> } | undefined;
    return entry?.customPhaseModels;
  };
}
