/**
 * zeenha fork: keys the renderer asks for by full name ("ns:key") must exist in
 * both languages, and en/fr must hold the same keys. Missing keys render as the
 * raw key text (the Worktrees "success" toast, the Memory row in Agent Tools,
 * GitLab severity labels and the MCP dialog buttons all did).
 *
 * Only literal, namespace-qualified keys with no default value are checked:
 * a key with a default still renders readable text.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../../..');
const LOCALES = path.resolve(__dirname, '../locales');
const LANGS = ['en', 'fr'] as const;

type Flat = Set<string>;

function flatten(obj: Record<string, unknown>, prefix = '', out: Flat = new Set()): Flat {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix + k;
    if (v && typeof v === 'object') flatten(v as Record<string, unknown>, `${key}.`, out);
    else out.add(key);
  }
  return out;
}

function loadLang(lang: string): Map<string, Flat> {
  const dir = path.join(LOCALES, lang);
  const map = new Map<string, Flat>();
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    map.set(file.replace(/\.json$/, ''), flatten(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'))));
  }
  return map;
}

function hasKey(keys: Flat | undefined, key: string): boolean {
  if (!keys) return false;
  if (keys.has(key)) return true;
  for (const k of keys) {
    if (k.startsWith(`${key}_`) || k.startsWith(`${key}.`)) return true; // plurals / returnObjects
  }
  return false;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      sourceFiles(p, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

const locales = Object.fromEntries(LANGS.map((l) => [l, loadLang(l)])) as Record<(typeof LANGS)[number], Map<string, Flat>>;

describe('i18n locale keys (zeenha fork)', () => {
  it('en and fr hold the same keys', () => {
    const diffs: string[] = [];
    for (const [ns, enKeys] of locales.en) {
      const frKeys = locales.fr.get(ns) ?? new Set<string>();
      for (const k of enKeys) if (!frKeys.has(k)) diffs.push(`fr missing ${ns}:${k}`);
      for (const k of frKeys) if (!enKeys.has(k)) diffs.push(`en missing ${ns}:${k}`);
    }
    expect(diffs).toEqual([]);
  });

  it('every namespace-qualified key used without a default exists in both languages', () => {
    const files = sourceFiles(path.join(SRC, 'renderer'));
    expect(files.length).toBeGreaterThan(100); // the scan really ran
    const pattern = /\bt\(\s*['"]([a-zA-Z]+):([a-zA-Z0-9_.-]+)['"]\s*(,\s*(['"`{]))?/g;
    const missing = new Set<string>();
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf-8');
      for (const m of src.matchAll(pattern)) {
        const [, ns, key, , secondArg] = m;
        // A string second argument is a default; so is an options object
        // carrying defaultValue (looked for in the next few hundred characters).
        if (secondArg && secondArg !== '{') continue;
        if (secondArg === '{' && src.slice(m.index, m.index + 600).includes('defaultValue')) continue;
        for (const lang of LANGS) {
          if (!hasKey(locales[lang].get(ns), key)) {
            missing.add(`${lang} ${ns}:${key} (${path.relative(SRC, file)})`);
          }
        }
      }
    }
    expect([...missing].sort()).toEqual([]);
  });
});
