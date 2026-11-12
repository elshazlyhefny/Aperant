/**
 * Tests for Path Containment
 *
 * Tests filesystem boundary checking to prevent escape from project directory.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertNotProtectedPath,
  assertPathContained,
  isPathContained,
  isProtectedProjectSecretPath,
} from '../path-containment';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let projectDir: string;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'security-test-'));
  // Create a subdirectory for testing
  fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'src', 'index.ts'), '');
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// assertPathContained
// ---------------------------------------------------------------------------

describe('assertPathContained', () => {
  it('allows file inside project directory', () => {
    const result = assertPathContained(
      path.join(projectDir, 'src', 'index.ts'),
      projectDir,
    );
    expect(result.contained).toBe(true);
  });

  it('allows relative path inside project', () => {
    const result = assertPathContained('src/index.ts', projectDir);
    expect(result.contained).toBe(true);
  });

  it('allows the project directory itself', () => {
    const result = assertPathContained(projectDir, projectDir);
    expect(result.contained).toBe(true);
  });

  it('throws for path outside project directory', () => {
    expect(() => assertPathContained('/etc/passwd', projectDir)).toThrow(
      'outside the project directory',
    );
  });

  it('throws for parent traversal (../)', () => {
    expect(() =>
      assertPathContained(path.join(projectDir, '..', 'escape'), projectDir),
    ).toThrow('outside the project directory');
  });

  it('throws for empty filePath', () => {
    expect(() => assertPathContained('', projectDir)).toThrow(
      'requires both',
    );
  });

  it('throws for empty projectDir', () => {
    expect(() => assertPathContained('/some/file', '')).toThrow(
      'requires both',
    );
  });

  it('allows non-existent file inside project', () => {
    const result = assertPathContained(
      path.join(projectDir, 'new-file.ts'),
      projectDir,
    );
    expect(result.contained).toBe(true);
  });

  it('allows deeply nested path inside project', () => {
    // Create parent dirs so symlink resolution works on macOS (/var -> /private/var)
    const deepDir = path.join(projectDir, 'a', 'b', 'c', 'd');
    fs.mkdirSync(deepDir, { recursive: true });
    const deepPath = path.join(deepDir, 'file.ts');
    const result = assertPathContained(deepPath, projectDir);
    expect(result.contained).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isPathContained (non-throwing variant)
// ---------------------------------------------------------------------------

describe('isPathContained', () => {
  it('returns contained=true for valid path', () => {
    const result = isPathContained(
      path.join(projectDir, 'src', 'index.ts'),
      projectDir,
    );
    expect(result.contained).toBe(true);
    expect(result.resolvedPath).toBeTruthy();
  });

  it('returns contained=false for path outside project', () => {
    const result = isPathContained('/etc/passwd', projectDir);
    expect(result.contained).toBe(false);
    expect(result.reason).toContain('outside the project directory');
  });

  it('returns contained=false for parent traversal', () => {
    const result = isPathContained(
      path.join(projectDir, '..', 'escape'),
      projectDir,
    );
    expect(result.contained).toBe(false);
  });

  it('returns contained=false for empty inputs', () => {
    const result = isPathContained('', projectDir);
    expect(result.contained).toBe(false);
    expect(result.reason).toContain('requires both');
  });

  it('handles absolute paths outside project', () => {
    const result = isPathContained('/usr/bin/evil', projectDir);
    expect(result.contained).toBe(false);
  });

  it('handles symlinks that escape project', () => {
    const symlinkPath = path.join(projectDir, 'escape-link');
    try {
      fs.symlinkSync('/tmp', symlinkPath);
      const result = isPathContained(symlinkPath, projectDir);
      expect(result.contained).toBe(false);
    } catch {
      // Symlink creation may fail on some systems/CI — skip gracefully
    }
  });
});

describe('isProtectedProjectSecretPath', () => {
  it('matches .env files directly inside .auto-claude', () => {
    for (const name of ['.env', '.env.local', '.env.production']) {
      expect(isProtectedProjectSecretPath(path.join(projectDir, '.auto-claude', name))).toBe(true);
    }
  });

  it('does not match .env at the project root or elsewhere', () => {
    expect(isProtectedProjectSecretPath(path.join(projectDir, '.env'))).toBe(false);
    expect(isProtectedProjectSecretPath(path.join(projectDir, 'src', '.env'))).toBe(false);
  });

  it('only matches direct children of .auto-claude', () => {
    expect(
      isProtectedProjectSecretPath(path.join(projectDir, '.auto-claude', 'specs', 'x', '.env')),
    ).toBe(false);
    expect(
      isProtectedProjectSecretPath(path.join(projectDir, '.auto-claude', 'other.json')),
    ).toBe(false);
  });

  it('covers a task worktree own .auto-claude/.env', () => {
    const worktree = path.join(projectDir, '.auto-claude', 'worktrees', 'tasks', '001-x');
    fs.mkdirSync(path.join(worktree, '.auto-claude'), { recursive: true });
    const envFile = path.join(worktree, '.auto-claude', '.env');
    fs.writeFileSync(envFile, 'TOKEN=x');

    const { resolvedPath } = assertPathContained(envFile, worktree);
    expect(isProtectedProjectSecretPath(resolvedPath)).toBe(true);
  });

  it('catches a symlink pointing at the protected file', () => {
    fs.mkdirSync(path.join(projectDir, '.auto-claude'), { recursive: true });
    const envFile = path.join(projectDir, '.auto-claude', '.env');
    fs.writeFileSync(envFile, 'TOKEN=x');
    const link = path.join(projectDir, 'innocent.txt');
    try {
      fs.symlinkSync(envFile, link);
    } catch {
      return; // Symlink creation may fail on some systems/CI — skip gracefully
    }

    const { resolvedPath } = assertPathContained(link, projectDir);
    expect(isProtectedProjectSecretPath(resolvedPath)).toBe(true);
    expect(() => assertNotProtectedPath(resolvedPath)).toThrow('blocked');
  });

  it('assertNotProtectedPath allows ordinary files', () => {
    expect(() => assertNotProtectedPath(path.join(projectDir, 'src', 'index.ts'))).not.toThrow();
  });
});
