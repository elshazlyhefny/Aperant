/**
 * zeenha fork: settings.json is written only through settings-utils.ts.
 *
 * updateSettingsFile() is the only sanctioned write entry point: it locks,
 * re-reads, and writes atomically with owner-only permissions (0o600) because
 * settings.json may hold credentials. A direct write or a read-modify-write via
 * writeSettingsFile() elsewhere could clobber concurrent updates or an
 * unreadable file, so this scans the main sources.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const MAIN = path.resolve(__dirname, '..');
const HELPER = 'settings-utils.ts';

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

const WRITE_CALL =
  /\b(?:writeFileSync|writeFile|promises\s*\.\s*writeFile|fsPromises\s*\.\s*writeFile|fs\s*\.\s*writeFile(?:Sync)?)\s*\(\s*(?:(?:settingsPath|currentSettingsPath)(?![\w$])|getSettingsPath\s*\(\s*\))/;

const WRITE_FN = /\b(?:writeFileSync|writeFile)\s*\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g;
const SETTINGS_VAR =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=[^;]*app\s*\.\s*getPath\s*\(\s*['"]userData['"]\s*\)[^;]*['"]settings\.json['"]/g;

/** Returns a description of each violation in the given source. */
function scan(source: string): string[] {
  const code = stripComments(source);
  const found: string[] = [];
  if (WRITE_CALL.test(code)) found.push('direct write to settings path');
  const vars = new Set([...code.matchAll(SETTINGS_VAR)].map((m) => m[1]));
  for (const m of code.matchAll(WRITE_FN)) {
    if (vars.has(m[1])) found.push(`writes userData/settings.json via ${m[1]}`);
  }
  return found;
}

/** True if the source mentions the raw writer, which only settings-utils.ts may use. */
const usesRawWriter = (source: string) => /\bwriteSettingsFile\b/.test(stripComments(source));

const files = sourceFiles(MAIN);

describe('settings.json write contract', () => {
  it('scanned a plausible number of files', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('only settings-utils.ts writes settings.json', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (path.basename(file) === HELPER) continue;
      for (const v of scan(readFileSync(file, 'utf-8'))) {
        offenders.push(`${path.relative(MAIN, file)}: ${v}`);
      }
    }
    expect(offenders, 'use writeSettingsFile() from settings-utils.ts').toEqual([]);
  });

  it('scanner flags synthetic offending snippets', () => {
    expect(scan('writeFileSync(settingsPath, data)')).not.toEqual([]);
    expect(scan('fs.writeFileSync(\n  currentSettingsPath,\n  data)')).not.toEqual([]);
    expect(scan('await promises.writeFile( getSettingsPath() , data)')).not.toEqual([]);
    expect(
      scan("const p = path.join(app.getPath('userData'), 'settings.json');\nwriteFileSync(p, d)")
    ).not.toEqual([]);
    expect(scan('// writeFileSync(settingsPath, data)')).toEqual([]);
  });

  it('writeSettingsFile is not used outside settings-utils.ts (use updateSettingsFile)', () => {
    const offenders = files
      .filter((f) => path.basename(f) !== HELPER)
      .filter((f) => usesRawWriter(readFileSync(f, 'utf-8')))
      .map((f) => path.relative(MAIN, f));
    expect(offenders, 'the only write entry point is updateSettingsFile()').toEqual([]);
  });

  it('files importing updateSettingsFile do not also use writeSettingsFile', () => {
    const offenders = files
      .filter((f) => path.basename(f) !== HELPER)
      .filter((f) => {
        const code = stripComments(readFileSync(f, 'utf-8'));
        return /\bupdateSettingsFile\b/.test(code) && /\bwriteSettingsFile\b/.test(code);
      })
      .map((f) => path.relative(MAIN, f));
    expect(offenders).toEqual([]);
  });

  it('raw-writer scanner flags synthetic offending snippets', () => {
    expect(usesRawWriter("import { writeSettingsFile } from './settings-utils';")).toBe(true);
    expect(usesRawWriter('writeSettingsFile({ ...readSettingsFile() ?? {}, a: 1 });')).toBe(true);
    expect(usesRawWriter('await updateSettingsFile((s) => s);')).toBe(false);
    expect(usesRawWriter('// writeSettingsFile(x)')).toBe(false);
  });

  it('settings-utils.ts is lock-protected and exports SettingsUnreadableError', () => {
    const helper = files.find((f) => path.basename(f) === HELPER);
    expect(helper).toBeDefined();
    const code = stripComments(readFileSync(helper as string, 'utf-8'));
    expect(code).toMatch(/proper-lockfile/);
    expect(code).toMatch(/lockfile\.lock\s*\(/);
    expect(code).toMatch(/export\s+class\s+SettingsUnreadableError\b/);
  });

  it('settings-utils.ts writes via temp file, rename and mode 0o600', () => {
    const helper = files.find((f) => path.basename(f) === HELPER);
    expect(helper).toBeDefined();
    const code = stripComments(readFileSync(helper as string, 'utf-8'));
    expect(code).toMatch(/\.tmp\b/);
    expect(code).toMatch(/renameSync\s*\(/);
    expect(code).toMatch(/0o600/);
  });
});
