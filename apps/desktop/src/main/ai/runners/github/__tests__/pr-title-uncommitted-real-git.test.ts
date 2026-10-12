/**
 * zeenha fork: the Create PR dialog's "suggest title" must see the work the
 * coder left uncommitted, and must not commit or stage it (the person has not
 * confirmed the PR yet). Run against real git, so "nothing changed" is a fact
 * about the repository rather than about a fake.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../env-utils', () => ({ getAugmentedEnv: () => ({ ...process.env }) }));
vi.mock('../../../client/factory', () => ({
  createSimpleClient: vi.fn(async () => ({ model: {}, systemPrompt: '' })),
}));
vi.mock('ai', () => ({ generateText: vi.fn(async () => ({ text: 'feat(shop): add the cart badge' })) }));

import { generateText } from 'ai';
import { suggestPRTitleForWorktree } from '../pr-creator';

let repo: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
/** A read that cannot itself rewrite the index, so snapshots do not disturb what they measure. */
const look = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();

/** Everything a suggestion could have changed: commits, index (bytes and mtime), working tree. */
function snapshot() {
  const indexPath = join(repo, '.git', 'index');
  const index = readFileSync(indexPath).toString('base64');
  const indexMtime = statSync(indexPath).mtimeMs;
  return {
    index,
    indexMtime,
    head: look('rev-parse', 'HEAD'),
    count: look('rev-list', '--count', '--all'),
    staged: look('diff', '--cached', '--name-only'),
    status: look('status', '--porcelain', '--untracked-files=all'),
  };
}

const lastPrompt = () => {
  const calls = vi.mocked(generateText).mock.calls;
  return String((calls[calls.length - 1]?.[0] as { prompt?: string }).prompt ?? '');
};

const suggest = () =>
  suggestPRTitleForWorktree({
    worktreePath: repo,
    gitPath: 'git',
    baseBranch: 'main',
    taskTitle: 'Cart badge',
    specId: '001-cart',
  });

beforeEach(() => {
  vi.mocked(generateText).mockClear();
  repo = mkdtempSync(join(tmpdir(), 'pr-title-uncommitted-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, '.gitignore'), '.auto-claude/\nbuild/\n');
  writeFileSync(join(repo, 'cart.ts'), 'export const items = [];\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'auto-claude/001-cart');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('suggestPRTitleForWorktree with uncommitted work (real git)', () => {
  it('shows the model the uncommitted edits and new files, and commits or stages nothing', async () => {
    writeFileSync(join(repo, 'cart.ts'), 'export const items = [];\nexport const badge = 1;\n');
    mkdirSync(join(repo, 'components'), { recursive: true });
    writeFileSync(join(repo, 'components', 'CartBadge.vue'), '<template />\n');
    const before = snapshot();

    expect(await suggest()).toBe('feat(shop): add the cart badge');

    const prompt = lastPrompt();
    expect(prompt).toContain('Uncommitted changes');
    expect(prompt).toContain('cart.ts');
    expect(prompt).toContain('components/CartBadge.vue');
    expect(snapshot()).toEqual(before);
  });

  it('leaves .auto-claude and gitignored files out of the prompt, tracked or not', async () => {
    writeFileSync(join(repo, 'cart.ts'), 'changed\n');
    mkdirSync(join(repo, '.auto-claude', 'specs'), { recursive: true });
    writeFileSync(join(repo, '.auto-claude', 'specs', 'secret-plan.json'), '{}');
    mkdirSync(join(repo, 'build'), { recursive: true });
    writeFileSync(join(repo, 'build', 'bundle-output.js'), 'x');

    await suggest();

    const prompt = lastPrompt();
    expect(prompt).toContain('cart.ts');
    expect(prompt).not.toContain('.auto-claude');
    expect(prompt).not.toContain('secret-plan');
    expect(prompt).not.toContain('bundle-output');
  });

  it('leaves .auto-claude out of the uncommitted section even where it is tracked and not ignored', async () => {
    writeFileSync(join(repo, '.gitignore'), 'build/\n');
    mkdirSync(join(repo, '.auto-claude'), { recursive: true });
    writeFileSync(join(repo, '.auto-claude', 'tracked-state.json'), '{}');
    git('add', '.');
    git('commit', '-q', '-m', 'track task files');
    writeFileSync(join(repo, '.auto-claude', 'tracked-state.json'), '{"changed":true}');
    writeFileSync(join(repo, '.auto-claude', 'new-state.json'), '{}');
    writeFileSync(join(repo, 'cart.ts'), 'changed\n');

    await suggest();

    // The committed diff summary above it may name the tracked .auto-claude
    // file (that is the branch's history); the uncommitted section may not.
    const uncommitted = lastPrompt().split('Uncommitted changes')[1] ?? '';
    expect(uncommitted).toContain('cart.ts');
    expect(uncommitted).not.toContain('.auto-claude');
  });

  it('includes staged-but-uncommitted changes without unstaging them', async () => {
    writeFileSync(join(repo, 'cart.ts'), 'staged edit\n');
    git('add', 'cart.ts');
    const before = snapshot();

    await suggest();

    expect(lastPrompt()).toContain('cart.ts');
    expect(snapshot()).toEqual(before);
    expect(before.staged).toBe('cart.ts');
  });

  it('adds no uncommitted section for a clean worktree', async () => {
    writeFileSync(join(repo, 'cart.ts'), 'committed\n');
    git('commit', '-q', '-am', 'feat: badge');

    await suggest();

    const prompt = lastPrompt();
    expect(prompt).toContain('feat: badge');
    expect(prompt).not.toContain('Uncommitted changes');
  });
});
