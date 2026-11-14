/**
 * zeenha fork: the task review worktree status and diff handlers run git
 * asynchronously so they no longer block the Electron main thread.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../../shared/constants';
// Imported statically: a cold import inside the first test counts against its timeout.
import {
  getEffectiveBaseBranch,
  getEffectiveBaseBranchAsync,
  getWorktreeNumstat,
  parseNumstat,
  summarizeNumstat,
} from '../worktree-git-utils';
import { registerWorktreeHandlers } from '../worktree-handlers';

const handlers = vi.hoisted(() => new Map<string, Function>());
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: Function) => handlers.set(ch, fn), on: vi.fn() },
  BrowserWindow: class {},
  shell: { openPath: vi.fn() },
  app: { getPath: () => os.tmpdir(), isPackaged: false, on: vi.fn() },
}));

const ref = vi.hoisted(() => ({ path: '', worktree: '', settings: {} as Record<string, unknown> }));
vi.mock('../shared', () => ({
  findTaskAndProject: () => ({
    task: { id: 't1', specId: '001-x', status: 'human_review', reviewReason: 'completed' },
    project: { id: 'p1', path: ref.path, autoBuildPath: '.auto-claude', settings: ref.settings },
  }),
}));
vi.mock('../../../worktree-paths', () => ({
  findTaskWorktree: () => ref.worktree,
  getTaskWorktreeDir: () => ref.worktree,
}));
vi.mock('../../../cli-tool-manager', () => ({ getToolPath: (tool: string) => tool }));

vi.mock('../../../ai/runners/github/pr-creator', () => ({
  createPR: vi.fn(),
  createMR: vi.fn(),
  createBitbucketPR: vi.fn(),
  suggestPRTitleForWorktree: vi.fn(async () => null),
}));
vi.mock('../../gitlab/utils', () => ({ getGitLabConfig: vi.fn(async () => null) }));
vi.mock('../../bitbucket/utils', () => ({ getBitbucketConfig: vi.fn(async () => null) }));

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function initRepo(dir: string, branch = 'main') {
  git(dir, 'init', '-q', '-b', branch);
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
}

function writeMetadata(content: Record<string, unknown>) {
  const dir = path.join(ref.path, '.auto-claude', 'specs', '001-x');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task_metadata.json'), JSON.stringify(content));
}

function getHandler<T>(channel: string) {
  registerWorktreeHandlers(() => null);
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`${channel} handler was not registered`);
  return fn as (e: unknown, taskId: string) => Promise<T>;
}

type StatusResult = {
  success: boolean;
  data?: {
    exists: boolean;
    worktreePath?: string;
    branch?: string;
    baseBranch?: string;
    commitCount?: number;
    filesChanged?: number;
    additions?: number;
    deletions?: number;
  };
};
type DiffResult = {
  success: boolean;
  data?: { files: { path: string; status: string; additions: number; deletions: number }[]; summary: string };
};

describe('worktree status and diff (async git, zeenha fork)', () => {
  const tmpDirs: string[] = [];
  const mk = (prefix: string) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
  };

  beforeEach(() => {
    handlers.clear();
    ref.settings = {};
    ref.path = mk('wt-async-repo-');
    ref.worktree = '';
  });

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  /** Main repo with one commit plus a worktree on a branch with committed and uncommitted changes. */
  function setupWorktree() {
    initRepo(ref.path);
    fs.writeFileSync(path.join(ref.path, 'keep.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(ref.path, 'mod.txt'), 'a\nb\nc\n');
    fs.writeFileSync(path.join(ref.path, 'gone.txt'), 'x\ny\n');
    git(ref.path, 'add', '.');
    git(ref.path, 'commit', '-q', '-m', 'init');

    const wt = path.join(mk('wt-async-tree-'), 'tree');
    git(ref.path, 'worktree', 'add', '-q', '-b', 'task/001-x', wt);
    ref.worktree = wt;

    // committed addition
    fs.writeFileSync(path.join(wt, 'added.txt'), '1\n2\n3\n');
    git(wt, 'add', 'added.txt');
    git(wt, 'commit', '-q', '-m', 'add file');
    // uncommitted: modify and delete (tracked), staged new file
    fs.writeFileSync(path.join(wt, 'mod.txt'), 'a\nB\nc\nd\n');
    fs.rmSync(path.join(wt, 'gone.txt'));
    fs.writeFileSync(path.join(wt, 'fresh.txt'), 'f\n');
    git(wt, 'add', 'fresh.txt');
    return wt;
  }

  describe('getEffectiveBaseBranchAsync', () => {
    it('prefers the task metadata branch, then the project mainBranch', async () => {
      initRepo(ref.path);
      writeMetadata({ baseBranch: 'release' });
      expect(await getEffectiveBaseBranchAsync(ref.path, '001-x', 'develop')).toBe('release');
      expect(getEffectiveBaseBranch(ref.path, '001-x', 'develop')).toBe('release');

      fs.rmSync(path.join(ref.path, '.auto-claude'), { recursive: true, force: true });
      expect(await getEffectiveBaseBranchAsync(ref.path, '001-x', 'develop')).toBe('develop');
      expect(getEffectiveBaseBranch(ref.path, '001-x', 'develop')).toBe('develop');
    });

    it('detects main, then master, then falls back to main', async () => {
      initRepo(ref.path, 'master');
      fs.writeFileSync(path.join(ref.path, 'f'), 'x');
      git(ref.path, 'add', '.');
      git(ref.path, 'commit', '-q', '-m', 'init');
      expect(await getEffectiveBaseBranchAsync(ref.path, '001-x')).toBe('master');
      expect(getEffectiveBaseBranch(ref.path, '001-x')).toBe('master');

      git(ref.path, 'branch', 'main');
      expect(await getEffectiveBaseBranchAsync(ref.path, '001-x')).toBe('main');

      const empty = mk('wt-async-empty-');
      initRepo(empty, 'trunk');
      expect(await getEffectiveBaseBranchAsync(empty, '001-x')).toBe('main');
      expect(getEffectiveBaseBranch(empty, '001-x')).toBe('main');
    });
  });

  describe('numstat helpers', () => {
    it('parses normal, binary and empty output', () => {
      expect(parseNumstat('')).toEqual([]);
      expect(parseNumstat('\n')).toEqual([]);
      const entries = parseNumstat('3\t1\tsrc/a.ts\n-\t-\timg.png\n');
      expect(entries).toEqual([
        { path: 'src/a.ts', additions: 3, deletions: 1 },
        { path: 'img.png', additions: 0, deletions: 0 },
      ]);
      expect(summarizeNumstat(entries)).toEqual({ filesChanged: 2, additions: 3, deletions: 1 });
      expect(summarizeNumstat([])).toEqual({ filesChanged: 0, additions: 0, deletions: 0 });
    });

    it('shares one in-flight git run between concurrent calls and does not cache afterwards', async () => {
      const wt = setupWorktree();
      const p1 = getWorktreeNumstat(wt, 'main');
      const p2 = getWorktreeNumstat(wt, 'main');
      expect(p2).toBe(p1);
      const first = await p1;
      expect(parseNumstat(first).map((e) => e.path).sort()).toEqual(['added.txt', 'fresh.txt', 'gone.txt', 'mod.txt']);

      fs.writeFileSync(path.join(wt, 'keep.txt'), 'one\ntwo\nthree\n');
      const p3 = getWorktreeNumstat(wt, 'main');
      expect(p3).not.toBe(p1);
      expect(parseNumstat(await p3).map((e) => e.path)).toContain('keep.txt');
    });
  });

  describe('TASK_WORKTREE_STATUS', () => {
    it('reports exists:false when there is no worktree', async () => {
      const result = await getHandler<StatusResult>(IPC_CHANNELS.TASK_WORKTREE_STATUS)({}, 't1');
      expect(result).toEqual({ success: true, data: { exists: false } });
    });

    it('reports branch, base branch, commit count and change totals', async () => {
      const wt = setupWorktree();
      const result = await getHandler<StatusResult>(IPC_CHANNELS.TASK_WORKTREE_STATUS)({}, 't1');
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        exists: true,
        worktreePath: wt,
        branch: 'task/001-x',
        baseBranch: 'main',
        commitCount: 1,
        filesChanged: 4,
        // added.txt +3, mod.txt +2 -1, gone.txt -2, fresh.txt +1
        additions: 6,
        deletions: 3,
      });
    });

    it('returns exists:true with the path when the worktree is not a git repo', async () => {
      ref.worktree = mk('wt-async-plain-');
      initRepo(ref.path);
      const result = await getHandler<StatusResult>(IPC_CHANNELS.TASK_WORKTREE_STATUS)({}, 't1');
      expect(result).toEqual({ success: true, data: { exists: true, worktreePath: ref.worktree } });
    });
  });

  describe('TASK_WORKTREE_DIFF', () => {
    it('returns per-file statuses and a summary matching the status handler', async () => {
      setupWorktree();
      const diff = await getHandler<DiffResult>(IPC_CHANNELS.TASK_WORKTREE_DIFF)({}, 't1');
      expect(diff.success).toBe(true);
      const byPath = Object.fromEntries((diff.data?.files ?? []).map((f) => [f.path, f]));
      expect(byPath['added.txt']).toMatchObject({ status: 'added', additions: 3, deletions: 0 });
      expect(byPath['fresh.txt']).toMatchObject({ status: 'added', additions: 1, deletions: 0 });
      expect(byPath['mod.txt']).toMatchObject({ status: 'modified', additions: 2, deletions: 1 });
      expect(byPath['gone.txt']).toMatchObject({ status: 'deleted', additions: 0, deletions: 2 });

      const status = await getHandler<StatusResult>(IPC_CHANNELS.TASK_WORKTREE_STATUS)({}, 't1');
      const { filesChanged, additions, deletions } = status.data ?? { exists: false };
      expect(diff.data?.summary).toBe(`${filesChanged} files changed, ${additions} insertions(+), ${deletions} deletions(-)`);
    });

    it('fails clearly when there is no worktree', async () => {
      const diff = await getHandler<DiffResult & { error?: string }>(IPC_CHANNELS.TASK_WORKTREE_DIFF)({}, 't1');
      expect(diff).toEqual({ success: false, error: 'No worktree found for this task' });
    });
  });

  describe('concurrency', () => {
    it('both handlers return promises and resolve when invoked concurrently', async () => {
      setupWorktree();
      const status = getHandler<StatusResult>(IPC_CHANNELS.TASK_WORKTREE_STATUS);
      const diff = getHandler<DiffResult>(IPC_CHANNELS.TASK_WORKTREE_DIFF);

      const calls = [status({}, 't1'), status({}, 't1'), diff({}, 't1'), diff({}, 't1')];
      for (const c of calls) expect(c).toBeInstanceOf(Promise);
      const [s1, s2, d1, d2] = await Promise.all(calls);

      expect((s1 as StatusResult).data).toEqual((s2 as StatusResult).data);
      expect((d1 as DiffResult).data).toEqual((d2 as DiffResult).data);
      expect((s1 as StatusResult).data?.filesChanged).toBe(4);
      expect((d1 as DiffResult).data?.files).toHaveLength(4);
    });
  });
});
