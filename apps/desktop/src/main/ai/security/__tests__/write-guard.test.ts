/**
 * Tests for the write guard (git internals + writeRoot).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assertNotGitInternal, assertWriteAllowed } from '../write-guard';

let projectDir: string;

beforeEach(() => {
  projectDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'write-guard-test-')),
  );
  fs.mkdirSync(path.join(projectDir, '.git', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.git', 'config'), '');
  fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, '.github'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'sub', '.git'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe('assertNotGitInternal', () => {
  it('blocks any .git segment, case-insensitively, with either separator', () => {
    expect(() => assertNotGitInternal('/a/.git/config')).toThrow();
    expect(() => assertNotGitInternal('/a/.GIT/config')).toThrow();
    expect(() => assertNotGitInternal('C:\\a\\.git\\config')).toThrow();
    expect(() => assertNotGitInternal('/a/.gitignore')).not.toThrow();
  });
});

describe('assertWriteAllowed', () => {
  const ctx = () => ({ projectDir });

  it('blocks .git/hooks/pre-commit', () => {
    expect(() =>
      assertWriteAllowed(path.join('.git', 'hooks', 'pre-commit'), ctx()),
    ).toThrow(/git/);
  });

  it('blocks .git/config', () => {
    expect(() => assertWriteAllowed('.git/config', ctx())).toThrow();
  });

  it('blocks a .git pointer file', () => {
    const wt = path.join(projectDir, 'wt');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /somewhere');
    expect(() => assertWriteAllowed(path.join(wt, '.git'), ctx())).toThrow();
  });

  it('blocks nested sub/.git/x', () => {
    expect(() => assertWriteAllowed('sub/.git/x', ctx())).toThrow();
  });

  it('blocks .GIT variant', () => {
    expect(() => assertWriteAllowed('.GIT/config', ctx())).toThrow();
  });

  it('blocks a symlink inside the project pointing into .git', () => {
    const link = path.join(projectDir, 'src', 'link');
    fs.symlinkSync(path.join(projectDir, '.git'), link);
    expect(() => assertWriteAllowed('src/link/config', ctx())).toThrow();
  });

  it('does not block .gitignore or .github/x', () => {
    expect(() => assertWriteAllowed('.gitignore', ctx())).not.toThrow();
    expect(() => assertWriteAllowed('.github/x', ctx())).not.toThrow();
  });

  it('allows a path inside writeRoot', () => {
    const result = assertWriteAllowed('src/a.ts', {
      projectDir,
      writeRoot: path.join(projectDir, 'src'),
    });
    expect(result.resolvedPath).toBe(path.join(projectDir, 'src', 'a.ts'));
  });

  it('blocks a path outside writeRoot but inside projectDir, naming writeRoot', () => {
    const writeRoot = path.join(projectDir, 'src');
    expect(() =>
      assertWriteAllowed('other.ts', { projectDir, writeRoot }),
    ).toThrow(writeRoot);
  });

  it('blocks ../ traversal out of writeRoot', () => {
    expect(() =>
      assertWriteAllowed('src/../other.ts', {
        projectDir,
        writeRoot: path.join(projectDir, 'src'),
      }),
    ).toThrow();
  });

  it('leaves behavior unchanged when writeRoot is unset', () => {
    const result = assertWriteAllowed('other.ts', ctx());
    expect(result.resolvedPath).toBe(path.join(projectDir, 'other.ts'));
  });
});
