/**
 * zeenha fork: the secret gate runs against real git, because path handling
 * (top level vs subdirectory cwd) is exactly what a fake would not prove.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  formatSecretFindings,
  listBranchFiles,
  listStagedFiles,
  scanChangedFiles,
} from '../secret-gate';

// Built at runtime so this source file does not itself trip the scanner.
const FAKE_KEY = 'sk-' + 'a1B2'.repeat(8);
const keyLine = `const k = "${FAKE_KEY}";\n`;

let repo: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
const write = (rel: string, content: string) => {
  const full = join(repo, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
};

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'secret-gate-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  write('base.ts', 'export const a = 1;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('secret gate (real git)', () => {
  it('finds a fake key in a staged file', () => {
    write('src/config.ts', keyLine);
    git('add', 'src/config.ts');

    const matches = scanChangedFiles(listStagedFiles(repo), repo);

    expect(matches).toHaveLength(1);
    expect(matches[0].filePath).toBe('src/config.ts');
    expect(matches[0].lineNumber).toBe(1);
  });

  it('reports nothing for a clean staged file', () => {
    write('src/clean.ts', 'export const b = 2;\n');
    git('add', 'src/clean.ts');

    expect(scanChangedFiles(listStagedFiles(repo), repo)).toEqual([]);
  });

  it('never prints the full key in the block message', () => {
    write('src/config.ts', keyLine);
    git('add', 'src/config.ts');
    const matches = scanChangedFiles(listStagedFiles(repo), repo);

    const message = formatSecretFindings(matches, 'commit');

    expect(message).toContain('src/config.ts:1');
    expect(message).toContain(FAKE_KEY.slice(0, 8) + '***');
    expect(message).not.toContain(FAKE_KEY);
    expect(message).not.toContain('const k');
    expect(message).toContain('.env.example');
    expect(message).toContain('.secretsignore');
  });

  it('honours a .secretsignore pattern from the repo top level', () => {
    write('tests/fixtures/key.ts', keyLine);
    write('.secretsignore', '^tests/fixtures/\n');
    git('add', '.');

    expect(scanChangedFiles(listStagedFiles(repo), repo)).toEqual([]);
  });

  it('ignores files under .auto-claude/', () => {
    write('.auto-claude/specs/001/notes.json', keyLine);

    expect(scanChangedFiles(['.auto-claude/specs/001/notes.json'], repo)).toEqual([]);
  });

  it('returns repo-relative paths when cwd is a subdirectory', () => {
    write('apps/desktop/src/secret.ts', keyLine);
    git('add', '.');
    const sub = join(repo, 'apps', 'desktop');

    const staged = listStagedFiles(sub);
    expect(staged).toEqual(['apps/desktop/src/secret.ts']);
    expect(scanChangedFiles(staged, repo)).toHaveLength(1);
  });

  it('lists only files changed since the base ref', () => {
    git('checkout', '-q', '-b', 'feature');
    write('feature.ts', 'export const c = 3;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'feature work');

    expect(listBranchFiles(repo, 'main')).toEqual(['feature.ts']);
  });

  it('returns [] outside a git repository', () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'secret-gate-nogit-')));
    try {
      expect(listStagedFiles(plain)).toEqual([]);
      expect(listBranchFiles(plain, 'main')).toEqual([]);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
