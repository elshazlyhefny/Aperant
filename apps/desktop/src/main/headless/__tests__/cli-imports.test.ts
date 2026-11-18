/**
 * zeenha fork: the headless CLI runs under plain node, so one static import of
 * Electron, electron-log or Sentry anywhere below cli.ts kills it at startup.
 * Same technique as ai/agent/__tests__/worker-imports.test.ts.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = path.resolve(__dirname, '../../..');
const CLI_ENTRY = path.join(SRC_ROOT, 'main/headless/cli.ts');
const FORBIDDEN = /^(electron($|-log($|\/))|@sentry\/electron($|\/))/;
const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^;'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;

function resolveLocal(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('.')) base = path.resolve(path.dirname(fromFile), specifier);
  else if (specifier.startsWith('@shared/')) base = path.join(SRC_ROOT, 'shared', specifier.slice('@shared/'.length));
  else return null;
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), base.replace(/\.js$/, '.ts')];
  return candidates.find((file) => existsSync(file) && statSync(file).isFile()) ?? null;
}

function collectReachable(entry: string): Set<string> {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    for (const match of readFileSync(file, 'utf8').matchAll(STATIC_IMPORT)) {
      const target = resolveLocal(file, match[1]);
      if (target && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return seen;
}

function findForbiddenChains(entry: string): string[] {
  const parent = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  const chains: string[] = [];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    for (const match of readFileSync(file, 'utf8').matchAll(STATIC_IMPORT)) {
      const specifier = match[1];
      if (FORBIDDEN.test(specifier)) {
        const chain = [specifier];
        for (let at: string | null = file; at; at = parent.get(at) ?? null) {
          chain.unshift(path.relative(SRC_ROOT, at));
        }
        chains.push(chain.join(' -> '));
        continue;
      }
      const target = resolveLocal(file, specifier);
      if (target && !parent.has(target)) {
        parent.set(target, file);
        queue.push(target);
      }
    }
  }
  return chains;
}

describe('headless cli imports', () => {
  it('never statically imports electron, electron-log or @sentry/electron', () => {
    expect(findForbiddenChains(CLI_ENTRY)).toEqual([]);
  });

  it('bundles the queue and schedule modules but not their Electron-bound siblings', () => {
    const reached = new Set([...collectReachable(CLI_ENTRY)].map((file) => path.basename(file)));
    for (const name of ['task-queue-manager.ts', 'schedule-service.ts', 'schedule-file-store.ts', 'webhook-core.ts',
      'github-writer.ts', 'gitlab-writer.ts', 'linear-writer.ts', 'headless-writers.ts',
      'issue-writeback-core.ts', 'jira-writeback-core.ts', 'github-api.ts', 'gitlab-api.ts', 'writeback.ts',
    ]) {
      expect(reached.has(name), `${name} should be reachable`).toBe(true);
    }
    for (const name of ['app-logger.ts', 'settings-utils.ts', 'schedule-store.ts', 'task-webhook.ts']) {
      expect(reached.has(name), `${name} must not be reachable`).toBe(false);
    }
  });

  it('does not reach the Electron-bound write-back modules', () => {
    const reached = new Set([...collectReachable(CLI_ENTRY)].map((file) => path.relative(SRC_ROOT, file)));
    for (const rel of [
      'main/ipc-handlers/forge/github-forge.ts',
      'main/ipc-handlers/forge/gitlab-forge.ts',
      'main/ipc-handlers/forge/registry.ts',
      'main/ipc-handlers/issue-writeback/issue-writeback.ts',
      'main/ipc-handlers/jira/jira-writeback.ts',
      'main/ipc-handlers/github/utils.ts',
      'main/ipc-handlers/gitlab/utils.ts',
      'main/task-failure-facts.ts',
    ]) {
      expect(reached.has(rel), `${rel} must not be reachable`).toBe(false);
    }
  });
});
