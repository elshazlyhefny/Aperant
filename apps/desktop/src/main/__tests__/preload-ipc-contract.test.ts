/**
 * zeenha fork: every channel the preload invokes has a main-process handler,
 * and every handler is reachable from the preload.
 *
 * Electron answers an invoke on a channel with no handler by rejecting
 * ("No handler registered"), and nothing notices until the feature is used:
 * the external-PR-review notification failed that way on every call. The
 * reverse, a handler no preload API reaches, is dead code the renderer cannot
 * call (contextIsolation), which hid four of those as well.
 *
 * Static: reads the sources, resolving IPC_CHANNELS.X through the real
 * constants. A channel built at runtime would not be seen, so any invoke whose
 * channel this cannot resolve fails the test instead of being skipped.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { IPC_CHANNELS } from '../../shared/constants/ipc';

const SRC = path.resolve(__dirname, '../..');

/**
 * Handlers kept although no preload API reaches them yet, each with why.
 * Shrink this list; never grow it to make the test pass.
 */
const UNEXPOSED_HANDLERS: Record<string, string> = {};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

/** Resolve a channel expression, or null when it cannot be resolved statically. */
function resolveChannel(expr: string, file: string): string | null {
  const e = expr.trim();
  const constant = /^IPC_CHANNELS\.([A-Z0-9_]+)$/.exec(e);
  if (constant) return (IPC_CHANNELS as Record<string, string>)[constant[1]] ?? null;
  const literal = /^(['"`])([^'"`$]+)\1$/.exec(e);
  if (literal) return literal[2];
  // A local `const name = 'literal'` in the same file (profile-api does this).
  const local = new RegExp(`const\\s+${e}\\s*=\\s*(['"\`])([^'"\`$]+)\\1`).exec(file);
  return local ? local[2] : null;
}

function collect(dir: string, call: RegExp, skip: (file: string, expr: string) => boolean) {
  const found = new Map<string, string[]>();
  const unresolved: string[] = [];
  for (const file of sourceFiles(dir)) {
    const text = stripComments(readFileSync(file, 'utf-8'));
    for (const m of text.matchAll(call)) {
      if (skip(file, m[1])) continue;
      const channel = resolveChannel(m[1], text);
      const where = path.relative(SRC, file);
      if (channel === null) unresolved.push(`${where}: ${m[1].trim()}`);
      else found.set(channel, [...(found.get(channel) ?? []), where]);
    }
  }
  return { found, unresolved };
}

// ipc-utils' invokeIpc(channel, ...) is the generic wrapper the others call.
const isWrapper = (file: string, expr: string) => file.endsWith(path.join('modules', 'ipc-utils.ts')) && expr.trim().startsWith('channel');
const invoked = collect(path.join(SRC, 'preload'), /(?:ipcRenderer\.invoke|invokeIpc(?:<[^>(]*>)?)\(\s*([^,)]+)/g, isWrapper);
const handled = collect(path.join(SRC, 'main'), /ipcMain\.handle(?:Once)?\(\s*([^,)]+)/g, () => false);

describe('preload <-> main IPC contract', () => {
  it('resolves every invoked and handled channel', () => {
    expect(invoked.unresolved).toEqual([]);
    // project-middleware.ts documents its helper with an example in a comment only.
    expect(handled.unresolved).toEqual([]);
    expect(invoked.found.size).toBeGreaterThan(100);
    expect(handled.found.size).toBeGreaterThan(100);
  });

  it('has a main-process handler for every channel the preload invokes', () => {
    const missing = [...invoked.found.keys()].filter((c) => !handled.found.has(c));
    expect(missing.map((c) => `${c} (${invoked.found.get(c)?.join(', ')})`)).toEqual([]);
  });

  it('reaches every main-process handler from the preload, apart from the listed ones', () => {
    const unreachable = [...handled.found.keys()].filter((c) => !invoked.found.has(c) && !(c in UNEXPOSED_HANDLERS));
    expect(unreachable.map((c) => `${c} (${handled.found.get(c)?.join(', ')})`)).toEqual([]);
  });

  it('lists only handlers that exist and are still unexposed', () => {
    for (const channel of Object.keys(UNEXPOSED_HANDLERS)) {
      expect(handled.found.has(channel), `${channel} has no handler`).toBe(true);
      expect(invoked.found.has(channel), `${channel} is exposed now: drop it from the list`).toBe(false);
    }
  });
});
