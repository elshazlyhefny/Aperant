/**
 * zeenha fork: the QA verify gate, run against real git, because what it
 * proves is that a task merged with the latest base still passes its checks.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildVerifyGateFixRequest,
  runVerifyGate,
  type VerifyGateOptions,
} from '../verify-gate';

/** Several real git processes per test; generous for a loaded CI runner. */
const GIT_TIMEOUT_MS = 60_000;

let root: string;
let origin: string;
let project: string;
let worktree: string;

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function configure(repo: string): void {
  gitIn(repo, 'config', 'user.email', 't@example.com');
  gitIn(repo, 'config', 'user.name', 'Test');
  gitIn(repo, 'config', 'commit.gpgsign', 'false');
}

function commit(repo: string, file: string, content: string, message: string): void {
  writeFileSync(join(repo, file), content);
  gitIn(repo, 'add', file);
  gitIn(repo, 'commit', '-q', '-m', message);
}

/** A second clone that pushes new base commits, as another merged task would. */
function pushToBase(file: string, content: string): void {
  const other = join(root, 'other');
  if (!existsSync(other)) {
    gitIn(root, 'clone', '-q', origin, other);
    configure(other);
  }
  gitIn(other, 'pull', '-q', 'origin', 'main');
  commit(other, file, content, `base: ${file}`);
  gitIn(other, 'push', '-q', 'origin', 'main');
}

const gate = (commands: string[], extra: Partial<VerifyGateOptions> = {}) =>
  runVerifyGate({
    worktreePath: worktree,
    projectPath: project,
    baseBranch: 'main',
    commands,
    waitForLoad: async () => 'quiet',
    ...extra,
  });

const worktreeCount = () => gitIn(project, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'verify-gate-')));
  origin = join(root, 'origin.git');
  project = join(root, 'project');
  worktree = join(root, 'task');
  gitIn(root, 'init', '-q', '--bare', '-b', 'main', origin);
  gitIn(root, 'clone', '-q', origin, project);
  configure(project);
  gitIn(project, 'checkout', '-q', '-b', 'main');
  commit(project, 'shared.txt', 'one\n', 'initial');
  gitIn(project, 'push', '-q', '-u', 'origin', 'main');
  gitIn(project, 'worktree', 'add', '-q', '-b', 'task/001', worktree, 'main');
  commit(worktree, 'feature.txt', 'feature\n', 'task work');
}, GIT_TIMEOUT_MS);
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('runVerifyGate', { timeout: GIT_TIMEOUT_MS }, () => {
  it('is skipped when the project declares no commands', async () => {
    expect(await gate([])).toEqual({ status: 'skipped' });
    expect(await runVerifyGate({ worktreePath: worktree, projectPath: project, baseBranch: 'main', commands: undefined }))
      .toEqual({ status: 'skipped' });
  });

  it('passes in the task worktree when the base is already contained', async () => {
    const result = await gate(['true', 'echo hello', 'test -f feature.txt']);
    expect(result).toEqual({ status: 'passed', base: 'origin/main', baseMerged: true, notes: [] });
  });

  // zeenha fork: the gate runs commands through cmd.exe on Windows, which has no
  // `;` separator or shell loops. Commands that must behave the same in sh and
  // cmd.exe are written as `node -e "..."`, with double quotes outside and no `$`.
  const FAILING = `node -e "console.log('boom-output'); console.error('on-stderr'); process.exit(3)"`;
  const WRITE_RAN_AFTER = `node -e "require('fs').writeFileSync('ran-after', '')"`;

  it('stops at the first failing command and reports its output tail', async () => {
    const result = await gate(['true', FAILING, WRITE_RAN_AFTER]);
    expect(result.status).toBe('failed');
    if (result.status !== 'failed' || result.reason !== 'command_failed') throw new Error('expected command_failed');
    expect(result.command).toBe(FAILING);
    expect(result.outputTail).toContain('boom-output');
    expect(result.outputTail).toContain('on-stderr');
    expect(existsSync(join(worktree, 'ran-after'))).toBe(false);
  });

  it('keeps only the last 4000 characters of output', async () => {
    const result = await gate([`node -e "for (let i = 0; i < 2000; i++) console.log('line-' + i); process.exit(1)"`]);
    if (result.status !== 'failed' || result.reason !== 'command_failed') throw new Error('expected command_failed');
    expect(result.outputTail.length).toBeLessThanOrEqual(4000);
    expect(result.outputTail).toContain('line-1999');
    expect(result.outputTail).not.toContain('line-0\n');
  });

  it('verifies the task merged with a base that moved on, without touching the task branch', async () => {
    pushToBase('from-base.txt', 'new trunk work\n');
    const headBefore = gitIn(worktree, 'rev-parse', 'HEAD');

    const result = await gate(['test -f from-base.txt', 'test -f feature.txt']);

    expect(result).toEqual({ status: 'passed', base: 'origin/main', baseMerged: true, notes: [] });
    expect(gitIn(worktree, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(existsSync(join(worktree, 'from-base.txt'))).toBe(false);
    expect(worktreeCount()).toBe(2); // project + task; the temporary one is gone
  });

  it('fails a check that only breaks once the latest base is merged in', async () => {
    pushToBase('from-base.txt', 'new trunk work\n');
    const result = await gate(['test ! -f from-base.txt']);
    expect(result).toMatchObject({ status: 'failed', reason: 'command_failed', baseMerged: true });
    expect(worktreeCount()).toBe(2);
  });

  it('reports the files when the base conflicts with the task', async () => {
    commit(worktree, 'shared.txt', 'task version\n', 'task edits shared');
    pushToBase('shared.txt', 'base version\n');

    const result = await gate(['true']);

    expect(result).toEqual({ status: 'failed', reason: 'base_conflict', files: ['shared.txt'], base: 'origin/main', notes: [] });
    expect(worktreeCount()).toBe(2);
    expect(readFileSync(join(worktree, 'shared.txt'), 'utf-8')).toBe('task version\n');
  });

  it('goes on against the local ref when the fetch fails', async () => {
    gitIn(project, 'remote', 'set-url', 'origin', join(root, 'missing.git'));
    const result = await gate(['true']);
    expect(result).toMatchObject({ status: 'passed', base: 'origin/main' });
    if (result.status !== 'passed') throw new Error('expected passed');
    expect(result.notes[0]).toContain('Could not fetch origin/main');
  });
});

describe('buildVerifyGateFixRequest', () => {
  it('follows the reviewer format and quotes the output safely', () => {
    const text = buildVerifyGateFixRequest(
      {
        status: 'failed',
        reason: 'command_failed',
        command: 'npm run typecheck',
        outputTail: 'error TS2322\n```\nnot a fence end',
        base: 'origin/main',
        baseMerged: true,
        notes: [],
      },
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(text).toContain('# QA Fix Request');
    expect(text).toContain('**Status**: REJECTED');
    expect(text).toContain('## Critical Issues to Fix');
    expect(text).toContain('`npm run typecheck`');
    expect(text).toContain('````text\nerror TS2322\n```\nnot a fence end\n````');
  });

  it('lists conflicting files for a base conflict', () => {
    const text = buildVerifyGateFixRequest({
      status: 'failed', reason: 'base_conflict', files: ['a.ts', 'b.ts'], base: 'origin/zeenha', notes: [],
    });
    expect(text).toContain('conflicts with origin/zeenha');
    expect(text).toContain('`a.ts`, `b.ts`');
    expect(text).toContain('git fetch origin zeenha');
  });
});
