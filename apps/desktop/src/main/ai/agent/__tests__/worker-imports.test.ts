/**
 * zeenha fork: a worker thread cannot load Electron, so one static import of it
 * anywhere below worker.ts kills every agent at startup. Unit tests mock
 * app-logger and electron, which hides that, so this reads the source instead.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = path.resolve(__dirname, '../../../..');
const WORKER_ENTRY = path.join(SRC_ROOT, 'main/ai/agent/worker.ts');
const FORBIDDEN = /^electron($|-log($|\/))/;
const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^;'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;

function resolveLocal(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('.')) base = path.resolve(path.dirname(fromFile), specifier);
  else if (specifier.startsWith('@shared/')) base = path.join(SRC_ROOT, 'shared', specifier.slice('@shared/'.length));
  else return null;

  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), base.replace(/\.js$/, '.ts')];
  return candidates.find((file) => existsSync(file) && statSync(file).isFile()) ?? null;
}

/** Breadth-first walk of static value imports; returns each chain that reaches Electron. */
function findElectronImportChains(entry: string): string[] {
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

describe('agent worker imports', () => {
  it('never statically imports Electron', () => {
    expect(findElectronImportChains(WORKER_ENTRY)).toEqual([]);
  });
});
