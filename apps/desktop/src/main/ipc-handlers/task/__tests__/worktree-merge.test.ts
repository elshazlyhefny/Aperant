/**
 * Characterization tests for the TASK_WORKTREE_MERGE handler. They pin the
 * current observable behavior (results, plan-file writes, progress events,
 * cleanup calls) so the handler can be split into smaller pieces safely.
 * git runs for real against a temp repo; the merge engine and AI are mocked.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../../shared/constants';
// Imported statically: a cold import of this graph inside a test counts against
// its timeout. vi.mock calls below are hoisted above this import.
import { registerWorktreeHandlers } from '../worktree-handlers';

const handlers = vi.hoisted(() => new Map<string, Function>());
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: Function) => handlers.set(ch, fn), on: vi.fn() },
  BrowserWindow: class {},
  shell: { openPath: vi.fn() },
  app: { getPath: () => os.tmpdir(), isPackaged: false, on: vi.fn() },
}));

const ref = vi.hoisted(() => ({
  path: '',
  worktree: '' as string | null,
  found: true,
  settings: {} as Record<string, unknown>,
}));
vi.mock('../shared', () => ({
  findTaskAndProject: () =>
    ref.found
      ? {
          task: { id: 't1', specId: '001-x' },
          project: { id: 'p1', path: ref.path, autoBuildPath: '.auto-claude', settings: ref.settings },
        }
      : { task: undefined, project: undefined },
}));
vi.mock('../../../worktree-paths', () => ({
  findTaskWorktree: () => ref.worktree,
  getTaskWorktreeDir: () => ref.worktree,
}));
vi.mock('../../../cli-tool-manager', () => ({ getToolPath: (tool: string) => tool }));

const orch = vi.hoisted(() => ({
  mergeTask: vi.fn(),
  applyToProject: vi.fn(),
}));
vi.mock('../../../ai/merge/orchestrator', () => ({
  MergeOrchestrator: class {
    mergeTask = orch.mergeTask;
    applyToProject = orch.applyToProject;
  },
}));
vi.mock('../../../ai/runners/merge-resolver', () => ({ createMergeResolverFn: vi.fn(() => vi.fn()) }));
const generateCommitMessage = vi.hoisted(() => vi.fn());
vi.mock('../../../ai/runners/commit-message', () => ({ generateCommitMessage }));
const cleanupWorktree = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/worktree-cleanup', () => ({ cleanupWorktree }));
const handleManualStatusChange = vi.hoisted(() => vi.fn());
vi.mock('../../../task-state-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../task-state-manager')>();
  return {
    ...actual,
    taskStateManager: { ...actual.taskStateManager, handleManualStatusChange },
  };
});

type MergeResult = {
  success: boolean;
  error?: string;
  data?: {
    success: boolean;
    message: string;
    staged?: boolean;
    projectPath?: string;
    suggestedCommitMessage?: string;
  };
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

const mainPlan = () => path.join(ref.path, '.auto-claude', 'specs', '001-x', 'implementation_plan.json');
const worktreePlan = () => path.join(ref.worktree as string, '.auto-claude', 'specs', '001-x', 'implementation_plan.json');
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf-8'));

const sends: Array<[string, string, Record<string, unknown>]> = [];
const fakeWindow = { webContents: { send: (...a: [string, string, Record<string, unknown>]) => sends.push(a) } };

async function merge(options: { noCommit?: boolean } = {}) {
  registerWorktreeHandlers(() => fakeWindow as never);
  const fn = handlers.get(IPC_CHANNELS.TASK_WORKTREE_MERGE);
  if (!fn) throw new Error('TASK_WORKTREE_MERGE handler was not registered');
  return (await fn({}, 't1', options)) as MergeResult;
}

/** The merge engine "applies" by writing a new file, which `git add -A` then stages. */
function applyWritesFile() {
  orch.applyToProject.mockImplementation(() => {
    fs.writeFileSync(path.join(ref.path, 'merged.txt'), 'merged\n');
    return true;
  });
}

describe('TASK_WORKTREE_MERGE characterization', () => {
  beforeEach(() => {
    handlers.clear();
    sends.length = 0;
    vi.clearAllMocks();
    orch.mergeTask.mockResolvedValue({ success: true, stats: {}, fileResults: new Map() });
    orch.applyToProject.mockReturnValue(true);
    generateCommitMessage.mockResolvedValue('feat: suggested message');
    cleanupWorktree.mockResolvedValue({ success: true, warnings: [] });

    ref.found = true;
    ref.settings = { prOnlyLanding: false };
    ref.path = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-char-'));
    ref.worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-char-wt-'));

    git(ref.path, 'init', '-q');
    fs.writeFileSync(path.join(ref.path, '.gitignore'), '.auto-claude\n');
    fs.writeFileSync(path.join(ref.path, 'README.md'), 'hi\n');
    git(ref.path, 'add', '-A');
    git(ref.path, 'commit', '-q', '-m', 'init');
    git(ref.path, 'branch', 'auto-claude/001-x');

    fs.mkdirSync(path.dirname(mainPlan()), { recursive: true });
    fs.writeFileSync(mainPlan(), JSON.stringify({ status: 'ai_review', phases: [] }));
  });

  it('full merge: reports success, cleans up the worktree and marks the plan done', async () => {
    applyWritesFile();
    const res = await merge();

    expect(res).toEqual({
      success: true,
      data: {
        success: true,
        message: 'Changes merged successfully',
        staged: false,
        projectPath: undefined,
        suggestedCommitMessage: undefined,
      },
    });
    expect(cleanupWorktree).toHaveBeenCalledTimes(1);
    expect(cleanupWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath: ref.worktree, projectPath: ref.path, specId: '001-x', deleteBranch: true })
    );
    const plan = readJson(mainPlan());
    expect(plan.status).toBe('done');
    expect(plan.planStatus).toBe('completed');
    expect(handleManualStatusChange).toHaveBeenCalledWith('t1', 'done', expect.anything(), expect.anything());
  });

  it('stage-only with staged changes: reports staged, suggests a message, keeps the worktree', async () => {
    applyWritesFile();
    const res = await merge({ noCommit: true });

    expect(res.success).toBe(true);
    expect(res.data?.success).toBe(true);
    expect(res.data?.message).toMatch(/^Changes staged in main project/);
    expect(res.data?.staged).toBe(true);
    expect(res.data?.projectPath).toBe(ref.path);
    expect(res.data?.suggestedCommitMessage).toBe('feat: suggested message');
    const plan = readJson(mainPlan());
    expect(plan.status).toBe('human_review');
    expect(plan.stagedInMainProject).toBe(true);
    expect(typeof plan.stagedAt).toBe('string');
    expect(cleanupWorktree).not.toHaveBeenCalled();
    expect(handleManualStatusChange).toHaveBeenCalledWith('t1', 'human_review', expect.anything(), expect.anything());
  });

  it('stage-only with nothing staged and the branch already merged', async () => {
    const res = await merge({ noCommit: true });

    expect(res.data?.success).toBe(true);
    expect(res.data?.message).toMatch(/^Changes were already merged/);
    expect(res.data?.staged).toBe(false);
    expect(readJson(mainPlan()).status).toBe('human_review');
    expect(cleanupWorktree).not.toHaveBeenCalled();
  });

  it('stage-only with nothing staged and the branch not merged', async () => {
    git(ref.path, 'checkout', '-q', 'auto-claude/001-x');
    fs.writeFileSync(path.join(ref.path, 'other.txt'), 'x\n');
    git(ref.path, 'add', '-A');
    git(ref.path, 'commit', '-q', '-m', 'task work');
    git(ref.path, 'checkout', '-q', '-');

    const res = await merge({ noCommit: true });

    expect(res.data?.success).toBe(true);
    expect(res.data?.message).toMatch(/^No changes to stage/);
    expect(res.data?.staged).toBe(false);
  });

  it('a failed merge report is returned as a failure and leaves the plan alone', async () => {
    orch.mergeTask.mockResolvedValue({ success: false, error: 'conflicts', stats: {}, fileResults: new Map() });
    const before = fs.readFileSync(mainPlan(), 'utf-8');

    const res = await merge();

    expect(res).toEqual({ success: true, data: { success: false, message: 'conflicts', conflictFiles: undefined } });
    expect(fs.readFileSync(mainPlan(), 'utf-8')).toBe(before);
    expect(handleManualStatusChange).not.toHaveBeenCalled();
    expect(cleanupWorktree).not.toHaveBeenCalled();
  });

  it('a throwing mergeTask is reported as a failure and emits an error progress event', async () => {
    orch.mergeTask.mockRejectedValue(new Error('boom'));

    const res = await merge();

    expect(res).toEqual({ success: true, data: { success: false, message: 'boom', conflictFiles: undefined } });
    const errorEvent = sends.find(([, , p]) => p.stage === 'error');
    expect(errorEvent?.[0]).toBe(IPC_CHANNELS.TASK_MERGE_PROGRESS);
    expect(errorEvent?.[1]).toBe('t1');
    expect(errorEvent?.[2].message).toBe('Merge failed: boom');
  });

  it('applyToProject returning false is a failure', async () => {
    orch.applyToProject.mockReturnValue(false);

    const res = await merge();

    expect(res.data?.success).toBe(false);
    expect(res.data?.message).toBe('Failed to apply merged files to project directory');
    expect(cleanupWorktree).not.toHaveBeenCalled();
  });

  it('sends the starting progress event first', async () => {
    await merge();

    expect(sends.length).toBeGreaterThan(0);
    const [channel, taskId, payload] = sends[0];
    expect(channel).toBe(IPC_CHANNELS.TASK_MERGE_PROGRESS);
    expect(taskId).toBe('t1');
    expect(payload).toMatchObject({ type: 'progress', stage: 'analyzing', percent: 0, message: 'Starting merge engine' });
  });

  it('returns Task not found when the task is unknown', async () => {
    ref.found = false;

    expect(await merge()).toEqual({ success: false, error: 'Task not found' });
    expect(orch.mergeTask).not.toHaveBeenCalled();
  });

  it('updates both the main plan and the worktree plan', async () => {
    fs.mkdirSync(path.dirname(worktreePlan()), { recursive: true });
    fs.writeFileSync(worktreePlan(), JSON.stringify({ status: 'ai_review', phases: [] }));

    await merge();

    for (const p of [mainPlan(), worktreePlan()]) {
      const plan = readJson(p);
      expect(plan.status).toBe('done');
      expect(plan.planStatus).toBe('completed');
    }
  });
});
