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
  else if (specifier.startsWith('@main/')) base = path.join(SRC_ROOT, 'main', specifier.slice('@main/'.length));
  else if (specifier.startsWith('@shared/')) base = path.join(SRC_ROOT, 'shared', specifier.slice('@shared/'.length));
  else return null;
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), base.replace(/\.js$/, '.ts')];
  return candidates.find((file) => existsSync(file) && statSync(file).isFile()) ?? null;
}

function localImports(file: string): string[] {
  const targets: string[] = [];
  for (const match of readFileSync(file, 'utf8').matchAll(STATIC_IMPORT)) {
    const target = resolveLocal(file, match[1]);
    if (target) targets.push(target);
  }
  return targets;
}

function collectReachable(entry: string): Set<string> {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    for (const target of localImports(file)) {
      if (!seen.has(target)) {
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

  it('bundles the shared task modules but not their Electron-bound siblings', () => {
    const reached = new Set([...collectReachable(CLI_ENTRY)].map((file) => path.basename(file)));
    for (const name of ['task-queue-manager.ts', 'schedule-service.ts', 'schedule-file-store.ts',
      'task-store.ts', 'task-record-fields.ts', 'shared.ts', 'preflight.ts', 'preflight-credentials.ts',
      'github-writer.ts', 'gitlab-writer.ts', 'linear-writer.ts', 'jira-writer.ts', 'headless-writers.ts',
      'issue-writeback-core.ts', 'issue-writeback-settings.ts', 'github-api.ts', 'gitlab-api.ts', 'writeback.ts',
    ]) {
      expect(reached.has(name), `${name} should be reachable`).toBe(true);
    }
    expect(reached.has('schedule-store.ts'), 'schedule-store.ts must not be reachable').toBe(false);
  });

  it('reaches both webhook adapters and they import the same shared core', () => {
    const reached = collectReachable(CLI_ENTRY);
    const core = path.join(SRC_ROOT, 'main/task-webhook-core.ts');
    for (const rel of ['main/headless/webhook.ts', 'main/webhook-core.ts']) {
      const adapter = path.join(SRC_ROOT, rel);
      expect(reached.has(adapter), `${rel} should be reachable`).toBe(true);
      expect(localImports(adapter), `${rel} should import the shared core`).toContain(core);
    }
  });

  it('does not reach desktop webhook, logging, settings or approval modules', () => {
    const reached = collectReachable(CLI_ENTRY);
    for (const rel of [
      'main/task-webhook.ts',
      'main/app-logger.ts',
      'main/settings-utils.ts',
      'main/project-webhook-config.ts',
      'main/webhook-approval-store.ts',
    ]) {
      expect(reached.has(path.join(SRC_ROOT, rel)), `${rel} must not be reachable`).toBe(false);
    }
  });

  it.each(['preflight.ts', 'preflight-credentials.ts'])('%s has no static dependency on runtime auth or execution', (name) => {
    const reached = collectReachable(path.join(SRC_ROOT, 'main/headless', name));
    for (const rel of [
      'main/ai/auth/resolver.ts',
      'main/claude-profile/credential-utils.ts',
      'main/claude-profile/token-refresh.ts',
      'main/ai/providers/oauth-fetch.ts',
      'main/ai/agent/worker-bridge-core.ts',
      'main/ai/worktree/worktree-manager.ts',
      'main/headless/auth.ts',
      'main/headless/run-task.ts',
      'main/headless/serve.ts',
    ]) {
      expect(reached.has(path.join(SRC_ROOT, rel)), `${rel} must not be reachable from ${name}`).toBe(false);
    }
  });

  it('does not reach ProjectStore or the Electron-bound write-back modules', () => {
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
      'main/project-store.ts',
    ]) {
      expect(reached.has(rel), `${rel} must not be reachable`).toBe(false);
    }
  });
});
