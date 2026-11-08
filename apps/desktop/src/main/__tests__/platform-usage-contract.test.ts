/**
 * zeenha fork: nothing outside main/platform reads process.platform directly.
 *
 * CLAUDE.md requires platform checks to go through main/platform. Without a
 * check the rule erodes one convenient call at a time, so this scans the
 * sources and fails on any file that is not on the allowlist below. The
 * allowlisted counts are exact, so removing a use also fails and tells you to
 * shrink the list.
 *
 * Static: comments are stripped first, so a mention in documentation is not a use.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../..');
const PLATFORM_DIR = path.join(SRC, 'main', 'platform');

/**
 * Files that still read process.platform, with the exact count and why.
 * Shrink this list; never grow it to make the test pass.
 */
const ALLOWED: Record<string, { count: number; reason: string }> = {
  'shared/platform.ts': { count: 1, reason: 'shared module; also used by the renderer and preload, which cannot import main' },
  'preload/index.ts': { count: 4, reason: 'preload bridge cannot import from main' },
  'main/utils/windows-paths.ts': { count: 4, reason: 'main/platform/index.ts imports it, so importing back is a cycle' },
  'main/claude-profile/credential-utils.ts': { count: 3, reason: 'error message text' },
  'main/app-logger.ts': { count: 1, reason: 'log field' },
  'main/ipc-handlers/settings-handlers.ts': { count: 1, reason: 'diagnostic console.warn' },
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      if (full === PLATFORM_DIR) continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

const files = sourceFiles(SRC);
const counts = new Map<string, number>();
for (const file of files) {
  const n = (stripComments(readFileSync(file, 'utf-8')).match(/\bprocess\.platform\b/g) ?? []).length;
  if (n > 0) counts.set(path.relative(SRC, file).split(path.sep).join('/'), n);
}

describe('platform abstraction contract', () => {
  it('scanned a plausible number of files', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('uses process.platform only in allowlisted files', () => {
    const offenders = [...counts].filter(([f]) => !(f in ALLOWED)).map(([f, n]) => `${f}: ${n} use(s)`);
    expect(offenders, 'import from main/platform instead of reading process.platform').toEqual([]);
  });

  it('keeps allowlisted counts exact', () => {
    for (const [file, { count, reason }] of Object.entries(ALLOWED)) {
      const actual = counts.get(file) ?? 0;
      expect(actual, `${file} (${reason}) has ${actual} use(s), expected ${count}: shrink the list if removed`).toBe(count);
    }
  });

  it('lists only files that exist', () => {
    for (const file of Object.keys(ALLOWED)) {
      expect(existsSync(path.join(SRC, file)), `${file} does not exist: drop it from the list`).toBe(true);
    }
  });
});
