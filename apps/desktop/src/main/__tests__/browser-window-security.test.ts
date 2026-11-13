/**
 * zeenha fork: the main window runs with the Chromium renderer sandbox on.
 *
 * Static: reads the sources. A sandboxed preload must be a single CJS file, so
 * the preload path in the main process has to match the electron-vite output.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const MAIN = path.resolve(__dirname, '..');
const DESKTOP = path.resolve(__dirname, '../../..');

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

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

const indexSrc = stripComments(readFileSync(path.join(MAIN, 'index.ts'), 'utf8'));
const viteSrc = stripComments(readFileSync(path.join(DESKTOP, 'electron.vite.config.ts'), 'utf8'));

function webPreferences(): string {
  const m = /webPreferences:\s*\{([\s\S]*?)\n\s*\}/.exec(indexSrc);
  if (!m) throw new Error('webPreferences block not found in src/main/index.ts');
  return m[1];
}

describe('main window security', () => {
  it('enables sandbox and context isolation, disables node integration', () => {
    const prefs = webPreferences();
    expect(prefs).toMatch(/sandbox:\s*true/);
    expect(prefs).toMatch(/contextIsolation:\s*true/);
    expect(prefs).toMatch(/nodeIntegration:\s*false/);
    expect(prefs).not.toMatch(/sandbox:\s*false/);
    expect(indexSrc).not.toMatch(/sandbox:\s*false/);
  });

  it('loads a CJS preload that matches the electron-vite preload output', () => {
    const m = /preload:\s*join\(__dirname,\s*['"]([^'"]+)['"]\)/.exec(webPreferences());
    expect(m).not.toBeNull();
    expect(m?.[1].endsWith('index.cjs')).toBe(true);
    expect(viteSrc).toMatch(/format:\s*['"]cjs['"]/);
    expect(viteSrc).toMatch(/entryFileNames:\s*['"]\[name\]\.cjs['"]/);
  });

  it('creates exactly one BrowserWindow in main sources', () => {
    let count = 0;
    for (const file of sourceFiles(MAIN)) {
      count += (stripComments(readFileSync(file, 'utf8')).match(/new BrowserWindow\(/g) ?? []).length;
    }
    expect(count).toBe(1);
  });
});
