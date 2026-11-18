/**
 * zeenha fork: the push-side secret gate in Create PR, run against real git so
 * the base-ref resolution, file listing and the "nothing was pushed" claim are
 * proven rather than faked.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../env-utils', () => ({ getAugmentedEnv: () => ({ ...process.env }) }));
vi.mock('../../../client/factory', () => ({
  createSimpleClient: vi.fn(async () => ({ model: {}, systemPrompt: '' })),
}));

import { prepareBranch, scanBranchForSecrets } from '../pr-creator';

// Built at runtime so this source file does not itself trip the scanner.
const FAKE_KEY = 'sk-' + 'a1B2'.repeat(8);
const keyLine = `const k = "${FAKE_KEY}";\n`;
const BRANCH = 'auto-claude/001-x';

let root: string;
let repo: string;
let origin: string;
const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
const git = (...args: string[]) => run(repo, ...args);
const write = (rel: string, content: string) => {
  const full = join(repo, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
};
const commit = (msg: string) => {
  git('add', '.');
  git('commit', '-q', '-m', msg);
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'pr-secret-gate-')));
  origin = join(root, 'origin.git');
  repo = join(root, 'work');
  mkdirSync(origin);
  mkdirSync(repo);
  run(origin, 'init', '-q', '--bare', '-b', 'main');
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  write('base.ts', 'export const a = 1;\n');
  commit('base');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', 'origin', 'main');
  git('fetch', '-q', 'origin');
  git('checkout', '-q', '-b', BRANCH);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('scanBranchForSecrets (real git)', () => {
  it('reports a key in a branch commit and never prints it in full', async () => {
    write('src/config.ts', keyLine);
    commit('add config');
    const result = await scanBranchForSecrets(repo, 'git', 'main');
    expect(result?.success).toBe(false);
    expect(result?.errorCode).toBe('SECRETS_DETECTED');
    expect(result?.error).toContain('src/config.ts:1');
    expect(result?.error).not.toContain(FAKE_KEY);
  });

  it('returns null for a clean branch', async () => {
    write('src/ok.ts', 'export const b = 2;\n');
    commit('clean');
    expect(await scanBranchForSecrets(repo, 'git', 'main')).toBeNull();
  });

  it('honours .secretsignore', async () => {
    write('.secretsignore', 'fixtures/\n');
    write('fixtures/key.ts', keyLine);
    commit('fixture');
    expect(await scanBranchForSecrets(repo, 'git', 'main')).toBeNull();
  });

  it('ignores a key that only exists on the base branch', async () => {
    git('checkout', '-q', 'main');
    write('legacy.ts', keyLine);
    commit('legacy key on base');
    git('push', '-q', 'origin', 'main');
    git('checkout', '-q', BRANCH);
    git('rebase', '-q', 'main');
    write('src/ok.ts', 'export const c = 3;\n');
    commit('clean work');
    expect(await scanBranchForSecrets(repo, 'git', 'main')).toBeNull();
  });

  it('fails closed when the base branch cannot be resolved', async () => {
    write('src/ok.ts', 'export const d = 4;\n');
    commit('work');
    const result = await scanBranchForSecrets(repo, 'git', 'no-such-branch');
    expect(result?.errorCode).toBe('SECRETS_DETECTED');
  });
});

describe('prepareBranch secret gate (real git)', () => {
  it('refuses a branch holding a key and does not push it', async () => {
    write('src/config.ts', keyLine);
    commit('add config');

    const result = await prepareBranch({
      projectDir: repo,
      worktreePath: repo,
      specId: '001-x',
      branchName: BRANCH,
      baseBranch: 'main',
      title: 'Add config',
      gitPath: 'git',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.result.errorCode).toBe('SECRETS_DETECTED');
      expect(result.result.error).not.toContain(FAKE_KEY);
    }
    expect(run(repo, 'ls-remote', 'origin')).not.toContain(BRANCH);
  });
});
