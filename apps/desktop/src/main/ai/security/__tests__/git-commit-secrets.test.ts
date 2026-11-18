import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bashSecurityHook, validateCommand } from '../bash-validator';

// Built at runtime so this test file itself holds no contiguous key.
const FAKE_KEY = ['sk', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4'].join('-');
const LEAK = `const apiToken = "${FAKE_KEY}";\n`;

let repo: string;

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
}

function run(command: string, cwd: string | null = repo) {
  const result = bashSecurityHook({ toolName: 'Bash', toolInput: { command }, cwd: cwd ?? undefined });
  if ('hookSpecificOutput' in result) {
    return {
      decision: result.hookSpecificOutput.permissionDecision as string | undefined,
      reason: result.hookSpecificOutput.permissionDecisionReason,
    };
  }
  return { decision: undefined, reason: '' };
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-secrets-'));
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  write('base.ts', 'export const a = 1;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('git commit secret scan (zeenha fork)', () => {
  it('denies a commit with a staged key and masks it', () => {
    write('src/leak.ts', LEAK);
    git('add', 'src/leak.ts');
    const { decision, reason } = run('git commit -m x');
    expect(decision).toBe('deny');
    expect(reason).toContain('src/leak.ts:1');
    expect(reason).toContain(`${FAKE_KEY.slice(0, 8)}***`);
    expect(reason).not.toContain(FAKE_KEY);
  });

  it('allows a commit with only clean staged files', () => {
    write('src/clean.ts', 'export const b = 2;\n');
    git('add', 'src/clean.ts');
    expect(run('git commit -m x').decision).toBeUndefined();
  });

  it('allows a staged key in a path matched by .secretsignore', () => {
    write('.secretsignore', 'fixtures/\n');
    write('fixtures/leak.ts', LEAK);
    git('add', '.');
    expect(run('git commit -m x').decision).toBeUndefined();
  });

  it('denies `git add . && git commit` with an unstaged new file holding a key', () => {
    write('src/new-leak.ts', LEAK);
    const { decision, reason } = run('git add . && git commit -m x');
    expect(decision).toBe('deny');
    expect(reason).toContain('src/new-leak.ts');
  });

  it('denies `git commit -am` with a modified tracked file holding a key', () => {
    write('base.ts', LEAK);
    const { decision, reason } = run('git commit -am x');
    expect(decision).toBe('deny');
    expect(reason).toContain('base.ts:1');
  });

  it('does not scan unstaged files for a plain commit', () => {
    write('base.ts', LEAK);
    expect(run('git commit -m x').decision).toBeUndefined();
  });

  it('never scans non-commit git commands', () => {
    write('src/leak.ts', LEAK);
    git('add', 'src/leak.ts');
    for (const command of ['git status', 'git log --oneline', 'git add .', 'git diff --cached']) {
      expect(run(command).decision).toBeUndefined();
    }
  });

  it('is unchanged without a cwd', () => {
    write('src/leak.ts', LEAK);
    git('add', 'src/leak.ts');
    expect(run('git commit -m x', null).decision).toBeUndefined();
    expect(validateCommand('git commit -m x')).toEqual([true, '']);
  });

  it('validateCommand denies with a cwd', () => {
    write('src/leak.ts', LEAK);
    git('add', 'src/leak.ts');
    expect(validateCommand('git commit -m x', null, repo)[0]).toBe(false);
  });

  it('fails open outside a git repository', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'no-repo-'));
    try {
      expect(run('git commit -m x', plain).decision).toBeUndefined();
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});
