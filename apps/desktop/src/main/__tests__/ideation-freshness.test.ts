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

import { findUnpulledCommits, MAX_LISTED_COMMITS, unpulledCommitsNote } from '../ideation-freshness';

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
