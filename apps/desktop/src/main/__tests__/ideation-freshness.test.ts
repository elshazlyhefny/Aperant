/**
 * zeenha fork: ideation warns its agents about merged commits the checkout
 * lacks. Real git: a bare "origin", the project clone, and a second clone that
 * pushes after the project last pulled.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../cli-tool-manager', () => ({ getToolPath: () => 'git' }));

import { mkdirSync } from 'node:fs';

import {
  checkoutUpdateLog,
  fastForwardCheckout,
  findUnpulledCommits,
  MAX_LISTED_COMMITS,
  unpulledCommitsNote,
} from '../ideation-freshness';

let root: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf-8' });

function commit(cwd: string, message: string) {
  writeFileSync(join(cwd, `${message.replace(/\W+/g, '-')}.txt`), message);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', message);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ideation-fresh-'));
  git(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  git(root, 'clone', '-q', 'origin.git', 'other');
  commit(join(root, 'other'), 'first');
  git(join(root, 'other'), 'push', '-q', 'origin', 'HEAD:main');
  git(root, 'clone', '-q', 'origin.git', 'project');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('findUnpulledCommits', () => {
  it('is null when the checkout is current', async () => {
    expect(await findUnpulledCommits(join(root, 'project'))).toBeNull();
  });

  it('fetches, then lists what landed after the last pull, newest first', async () => {
    commit(join(root, 'other'), 'Translate untranslated strings');
    commit(join(root, 'other'), 'Branch location autofill');
    git(join(root, 'other'), 'push', '-q', 'origin', 'HEAD:main');

    const unpulled = await findUnpulledCommits(join(root, 'project'));

    expect(unpulled?.upstream).toBe('origin/main');
    expect(unpulled?.count).toBe(2);
    expect(unpulled?.subjects.map((s) => s.replace(/^\w+ /, ''))).toEqual(['Branch location autofill', 'Translate untranslated strings']);
    // the checkout itself was not pulled
    expect(git(join(root, 'project'), 'log', '--format=%s').trim()).toBe('first');
  });

  it('is null outside a git repository', async () => {
    expect(await findUnpulledCommits(root)).toBeNull();
  });
});

describe('unpulledCommitsNote', () => {
  it('names the upstream, the commits and how to read the merged files', () => {
    const note = unpulledCommitsNote({ upstream: 'origin/main', count: 2, subjects: ['abc1234 One', 'def5678 Two'] });
    expect(note).toContain('2 commits behind `origin/main`');
    expect(note).toContain('- abc1234 One\n- def5678 Two');
    expect(note).toContain('git show origin/main:<path>');
  });

  it('counts the commits it did not list', () => {
    const subjects = Array.from({ length: MAX_LISTED_COMMITS }, (_, i) => `sha${i} s${i}`);
    expect(unpulledCommitsNote({ upstream: 'origin/main', count: MAX_LISTED_COMMITS + 5, subjects })).toContain('…and 5 older ones');
  });
});

describe('fastForwardCheckout (roadmap)', () => {
  const project = () => join(root, 'project');
  const head = () => git(project(), 'log', '--format=%s').trim().split('\n');

  function landUpstream(...messages: string[]) {
    for (const m of messages) commit(join(root, 'other'), m);
    git(join(root, 'other'), 'push', '-q', 'origin', 'HEAD:main');
  }

  it('is current when nothing landed', async () => {
    expect(await fastForwardCheckout(project())).toEqual({ kind: 'current' });
  });

  it('fast-forwards a clean branch onto its own upstream', async () => {
    landUpstream('Merge PR #442', 'Merge PR #449');

    const update = await fastForwardCheckout(project());

    expect(update).toMatchObject({ kind: 'pulled', upstream: 'origin/main', count: 2 });
    expect(head()).toEqual(['Merge PR #449', 'Merge PR #442', 'first']);
    expect(checkoutUpdateLog(update)).toContain('fast-forwarded 2 commit(s) from origin/main');
  });

  it("does not count Aperant's own .auto-claude files as changes", async () => {
    // tracked here so the exclusion is what lets it through, not an ignore rule
    mkdirSync(join(project(), '.auto-claude'));
    writeFileSync(join(project(), '.auto-claude', 'roadmap.json'), '{}');
    git(project(), 'add', '-A');
    git(project(), 'commit', '-qm', 'track state');
    git(project(), 'push', '-q', 'origin', 'HEAD:main');
    git(join(root, 'other'), 'pull', '-q', 'origin', 'main');
    writeFileSync(join(project(), '.auto-claude', 'roadmap.json'), '{"changed":true}');
    landUpstream('Merge PR #449');

    expect((await fastForwardCheckout(project())).kind).toBe('pulled');
  });

  it('leaves a checkout with uncommitted changes alone and says why', async () => {
    writeFileSync(join(project(), 'first.txt'), 'edited by the person');
    landUpstream('Merge PR #449');

    const update = await fastForwardCheckout(project());

    expect(update).toMatchObject({ kind: 'behind', reason: 'it has uncommitted changes' });
    expect(update.kind === 'behind' && update.unpulled.count).toBe(1);
    expect(head()).toEqual(['first']);
    expect(checkoutUpdateLog(update)).toContain('was NOT updated: it has uncommitted changes');
  });

  it('never merges: a branch with its own commits is left alone', async () => {
    commit(project(), 'local work');
    landUpstream('Merge PR #449');

    const update = await fastForwardCheckout(project());

    expect(update).toMatchObject({ kind: 'behind' });
    expect(update.kind === 'behind' && update.reason).toContain('cannot be fast-forwarded');
    expect(head()).toEqual(['local work', 'first']);
  });

  it('does not move a detached HEAD or a branch without a remote branch', async () => {
    landUpstream('Merge PR #449');
    git(project(), 'checkout', '-q', '--detach');

    const update = await fastForwardCheckout(project());

    expect(update).toMatchObject({ kind: 'behind', reason: 'the current branch does not track a remote branch' });
    expect(head()).toEqual(['first']);
  });
});
