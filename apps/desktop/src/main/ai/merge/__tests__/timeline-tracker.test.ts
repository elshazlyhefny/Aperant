import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import { FileTimelineTracker } from '../timeline-tracker';

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_SYSTEM: os.devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: GIT_ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

describe('FileTimelineTracker', () => {
  let root: string;
  let projectDir: string;
  let storageDir: string;
  let baseCommit: string;

  const write = (dir: string, rel: string, content: string) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  };
  const commitAll = (dir: string, msg: string) => {
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', msg);
    return git(dir, 'rev-parse', 'HEAD');
  };
  const make = () => new FileTimelineTracker(projectDir, storageDir);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'timeline-tracker-'));
    projectDir = path.join(root, 'project');
    storageDir = path.join(root, 'storage');
    fs.mkdirSync(projectDir, { recursive: true });
    git(projectDir, 'init', '-b', 'main');
    write(projectDir, 'src/a.ts', 'const a = 1;\n');
    write(projectDir, 'src/b.ts', 'const b = 1;\n');
    baseCommit = commitAll(projectDir, 'base');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('onTaskStart creates timelines with branch point content', () => {
    const t = make();
    t.onTaskStart('t1', ['src/a.ts', 'src/new.ts'], [], undefined, 'do things', 'Title');

    expect(t.hasTimeline('src/a.ts')).toBe(true);
    const view = t.getTimeline('src/a.ts')!.taskViews.get('t1')!;
    expect(view.branchPoint.commitHash).toBe(baseCommit);
    expect(view.branchPoint.content).toBe('const a = 1;');
    expect(view.taskIntent).toEqual({ title: 'Title', description: 'do things', fromPlan: true });
    expect(view.status).toBe('active');
    // file absent at the branch point -> empty content
    expect(t.getTimeline('src/new.ts')!.taskViews.get('t1')!.branchPoint.content).toBe('');
  });

  it('onTaskStart defaults the title to the task id and fromPlan to false', () => {
    const t = make();
    t.onTaskStart('t1', ['src/a.ts'], [], baseCommit);
    const view = t.getTimeline('src/a.ts')!.taskViews.get('t1')!;
    expect(view.taskIntent).toEqual({ title: 't1', description: '', fromPlan: false });
  });

  it('onTaskWorktreeChange stores worktree content for known tasks only', () => {
    const t = make();
    t.onTaskStart('t1', ['src/a.ts'], [], baseCommit);
    t.onTaskWorktreeChange('t1', 'src/a.ts', 'const a = 2;');
    expect(t.getTimeline('src/a.ts')!.taskViews.get('t1')!.worktreeState!.content).toBe('const a = 2;');

    t.onTaskWorktreeChange('ghost', 'src/a.ts', 'x');
    expect(t.getTimeline('src/a.ts')!.taskViews.has('ghost')).toBe(false);
  });

  it('onMainBranchCommit records events only for tracked files', () => {
    const t = make();
    t.onTaskStart('t1', ['src/a.ts'], [], baseCommit);
    write(projectDir, 'src/a.ts', 'const a = 5;\n');
    write(projectDir, 'src/b.ts', 'const b = 5;\n');
    const c2 = commitAll(projectDir, 'human change');
    t.onMainBranchCommit(c2);

    const events = t.getTimeline('src/a.ts')!.mainBranchEvents;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      commitHash: c2,
      content: 'const a = 5;',
      source: 'human',
      commitMessage: 'human change',
      author: 'Test',
    });
    expect(t.hasTimeline('src/b.ts')).toBe(false);
  });

  it('getMergeContext returns undefined for unknown file/task', () => {
    const t = make();
    t.onTaskStart('t1', ['src/a.ts'], [], baseCommit);
    expect(t.getMergeContext('t1', 'nope.ts')).toBeUndefined();
    expect(t.getMergeContext('ghost', 'src/a.ts')).toBeUndefined();
  });

  it('getMergeContext assembles context with main evolution and other tasks', () => {
    const t = make();
    t.onTaskStart('t1', ['src/a.ts'], [], baseCommit, 'intent1');
    t.onTaskStart('t2', ['src/a.ts'], [], baseCommit, 'intent2');
    t.onTaskWorktreeChange('t1', 'src/a.ts', 'const a = 2;');
    write(projectDir, 'src/a.ts', 'const a = 9;\n');
    const c2 = commitAll(projectDir, 'main change');
    t.onMainBranchCommit(c2);

    const ctx = t.getMergeContext('t1', 'src/a.ts')!;
    expect(ctx.taskWorktreeContent).toBe('const a = 2;');
    expect(ctx.currentMainContent).toBe('const a = 9;');
    expect(ctx.currentMainCommit).toBe(c2);
    expect(ctx.mainEvolution).toHaveLength(1);
    expect(ctx.taskBranchPoint.commitHash).toBe(baseCommit);
    expect(ctx.totalPendingTasks).toBe(1);
    expect(ctx.otherPendingTasks[0]).toMatchObject({ taskId: 't2', intent: 'intent2' });
  });

  it('getMergeContext falls back to branch point content with no main events', () => {
    const t = make();
    t.onTaskStart('t1', ['src/a.ts'], [], baseCommit);
    const ctx = t.getMergeContext('t1', 'src/a.ts')!;
    expect(ctx.currentMainContent).toBe('const a = 1;');
    expect(ctx.currentMainCommit).toBe(baseCommit);
    expect(ctx.taskWorktreeContent).toBe('');
  });

  it('getMergeContext reads the worktree file when no worktree state is stored', () => {
    const t = make();
    t.onTaskStart('t1', ['src/a.ts'], [], baseCommit);
    write(path.join(projectDir, '.auto-claude', 'worktrees', 't1'), 'src/a.ts', 'from disk');
    expect(t.getMergeContext('t1', 'src/a.ts')!.taskWorktreeContent).toBe('from disk');
  });

  it('getFilesForTask and getPendingTasksForFile', () => {
    const t = make();
    t.onTaskStart('t1', ['src/a.ts', 'src/b.ts'], [], baseCommit);
    t.onTaskStart('t2', ['src/a.ts'], [], baseCommit);
    expect(t.getFilesForTask('t1').sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(t.getFilesForTask('t2')).toEqual(['src/a.ts']);
    expect(t.getFilesForTask('none')).toEqual([]);
    expect(t.getPendingTasksForFile('src/a.ts').map((v) => v.taskId).sort()).toEqual(['t1', 't2']);
    expect(t.getPendingTasksForFile('unknown.ts')).toEqual([]);
  });

  it('onTaskMerged marks merged and adds a merged_task event', () => {
    const t = make();
    t.onTaskStart('t1', ['src/a.ts'], [], baseCommit);
    write(projectDir, 'src/a.ts', 'const a = 7;\n');
    const mc = commitAll(projectDir, 'merge t1');
    t.onTaskMerged('t1', mc);

    const tl = t.getTimeline('src/a.ts')!;
    const view = tl.taskViews.get('t1')!;
    expect(view.status).toBe('merged');
    expect(view.mergedAt).toBeInstanceOf(Date);
    expect(tl.mainBranchEvents[0]).toMatchObject({
      source: 'merged_task',
      mergedFromTask: 't1',
      commitMessage: 'Merged from t1',
      content: 'const a = 7;',
    });
    expect(t.getPendingTasksForFile('src/a.ts')).toEqual([]);
  });

  it('onTaskAbandoned marks views abandoned and excludes them from pending/drift', () => {
    const t = make();
    t.onTaskStart('t1', ['src/a.ts'], [], baseCommit);
    t.onTaskAbandoned('t1');
    expect(t.getTimeline('src/a.ts')!.taskViews.get('t1')!.status).toBe('abandoned');
    expect(t.getPendingTasksForFile('src/a.ts')).toEqual([]);
    expect(t.getTaskDrift('t1').size).toBe(0);
  });

  it('getTaskDrift reports commitsBehindMain for active tasks', () => {
    const t = make();
    t.onTaskStart('t1', ['src/a.ts', 'src/b.ts'], [], baseCommit);
    const drift = t.getTaskDrift('t1');
    expect([...drift.entries()].sort()).toEqual([['src/a.ts', 0], ['src/b.ts', 0]]);
  });

  it('persists timelines and reloads them in a new tracker', () => {
    const t = make();
    t.onTaskStart('t1', ['src/a.ts'], [], baseCommit, 'intent', 'Title');
    t.onTaskWorktreeChange('t1', 'src/a.ts', 'wt');
    write(projectDir, 'src/a.ts', 'const a = 3;\n');
    t.onMainBranchCommit(commitAll(projectDir, 'c2'));

    const reloaded = make();
    expect(reloaded.hasTimeline('src/a.ts')).toBe(true);
    const tl = reloaded.getTimeline('src/a.ts')!;
    const view = tl.taskViews.get('t1')!;
    expect(view.taskIntent.title).toBe('Title');
    expect(view.worktreeState!.content).toBe('wt');
    expect(view.branchPoint.timestamp).toBeInstanceOf(Date);
    expect(tl.mainBranchEvents).toHaveLength(1);
    expect(tl.mainBranchEvents[0].commitMessage).toBe('c2');
  });

  it('initializeFromWorktree and captureWorktreeState use a real git worktree', () => {
    const wt = path.join(root, 'wt');
    git(projectDir, 'worktree', 'add', '-b', 'task-branch', wt);
    write(wt, 'src/a.ts', 'const a = 42;\n');
    commitAll(wt, 'task change');
    // main moves on by one commit
    write(projectDir, 'src/b.ts', 'const b = 2;\n');
    commitAll(projectDir, 'main moves');

    const t = make();
    t.initializeFromWorktree('t1', wt, 'intent', 'Title', 'main');

    const view = t.getTimeline('src/a.ts')!.taskViews.get('t1')!;
    expect(view.branchPoint.commitHash).toBe(baseCommit);
    expect(view.worktreeState!.content).toBe('const a = 42;\n');
    expect(view.commitsBehinMain).toBe(1);
    expect(t.hasTimeline('src/b.ts')).toBe(false);

    // captureWorktreeState picks up newer committed content
    write(wt, 'src/a.ts', 'const a = 43;\n');
    commitAll(wt, 'again');
    t.captureWorktreeState('t1', wt);
    expect(t.getTimeline('src/a.ts')!.taskViews.get('t1')!.worktreeState!.content).toBe('const a = 43;\n');
  });

  it('initializeFromWorktree is a no-op for a non-git path', () => {
    const t = make();
    const dir = path.join(root, 'plain');
    fs.mkdirSync(dir);
    t.initializeFromWorktree('t1', dir);
    expect(t.getFilesForTask('t1')).toEqual([]);
  });
});
