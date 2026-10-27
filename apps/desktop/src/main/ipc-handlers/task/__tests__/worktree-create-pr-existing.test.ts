/**
 * zeenha fork: when a PR for the task's own branch already exists (a lost
 * reply on the first attempt, or Create PR again after the merge queue sent
 * it back), the task must still record it. Before the fix the task stayed in
 * Human Review with no PR link, and every later click said "already exists".
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../../shared/constants';
// Imported statically, not inside a test or hook: a cold import of this graph
// inside the first test counts against its timeout under a loaded suite run.
// vi.mock calls below are hoisted above these imports, so the mocks apply.
import { taskStateManager } from '../../../task-state-manager';
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

const createPR = vi.hoisted(() => vi.fn());
// zeenha fork: with no title sent (the bulk dialog), the handler asks for an AI title.
const suggestPRTitleForWorktree = vi.hoisted(() => vi.fn(async () => null as string | null));
vi.mock('../../../ai/runners/github/pr-creator', () => ({ createPR, suggestPRTitleForWorktree }));

const PR_URL = 'https://github.com/owner/repo/pull/7';

function specFile(name: string) {
  return path.join(ref.path, '.auto-claude', 'specs', '001-x', name);
}

async function createPrHandler() {
  registerWorktreeHandlers(() => null);
  const fn = handlers.get(IPC_CHANNELS.TASK_WORKTREE_CREATE_PR);
  if (!fn) throw new Error('TASK_WORKTREE_CREATE_PR handler was not registered');
  return fn as (e: unknown, taskId: string, options?: Record<string, unknown>) => Promise<{
    success: boolean;
    data?: { success: boolean; prUrl?: string; alreadyExists?: boolean };
  }>;
}

async function resetStateMachine() {
  taskStateManager.clearTask('t1');
}

describe('Create PR when the PR already exists (zeenha fork)', () => {
  beforeEach(async () => {
    await resetStateMachine();
    handlers.clear();
    createPR.mockReset();
    ref.path = fs.mkdtempSync(path.join(os.tmpdir(), 'create-pr-'));
    ref.worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'create-pr-wt-'));
    ref.settings = {};
    fs.mkdirSync(path.dirname(specFile('x')), { recursive: true });
    fs.writeFileSync(specFile('implementation_plan.json'), JSON.stringify({ status: 'human_review', phases: [] }));
    fs.writeFileSync(specFile('task_metadata.json'), JSON.stringify({}));
  });

  it('records the existing PR on the task and marks it done', async () => {
    createPR.mockResolvedValue({ success: true, prUrl: PR_URL, alreadyExists: true });
    const handler = await createPrHandler();

    const result = await handler({}, 't1');

    expect(result.data).toMatchObject({ success: true, prUrl: PR_URL, alreadyExists: true });
    expect(JSON.parse(fs.readFileSync(specFile('task_metadata.json'), 'utf-8')).prUrl).toBe(PR_URL);
    expect(JSON.parse(fs.readFileSync(specFile('implementation_plan.json'), 'utf-8')).status).toBe('done');
  });

  // zeenha fork: the plan said done while xstateState still said human_review,
  // because only the file was updated and the state machine never heard of it.
  it('moves the task state machine to done, not only the plan status', async () => {
    createPR.mockResolvedValue({ success: true, prUrl: PR_URL, alreadyExists: false });
    const handler = await createPrHandler();

    await handler({}, 't1');

    const plan = JSON.parse(fs.readFileSync(specFile('implementation_plan.json'), 'utf-8'));
    expect(plan.status).toBe('done');
    expect(plan.xstateState).toBe('done');
      expect(taskStateManager.getCurrentState('t1')).toBe('done');
  });

  it('opens the PR against the project main branch when the task has none', async () => {
    ref.settings = { mainBranch: 'develop' };
    createPR.mockResolvedValue({ success: true, prUrl: PR_URL, alreadyExists: false });
    const handler = await createPrHandler();

    await handler({}, 't1');

    expect(createPR.mock.calls[0][0].baseBranch).toBe('develop');
  });

  it('leaves the task alone when the existing PR could not be read', async () => {
    createPR.mockResolvedValue({ success: true, prUrl: undefined, alreadyExists: true });
    const handler = await createPrHandler();

    await handler({}, 't1');

    expect(JSON.parse(fs.readFileSync(specFile('task_metadata.json'), 'utf-8')).prUrl).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(specFile('implementation_plan.json'), 'utf-8')).status).toBe('human_review');
  });

  // zeenha fork: PR titles
  // The AI title is asked for inside createPR, after pending work is committed
  // (pr-creator.test.ts); the handler must not ask for one first.
  it('leaves the title to createPR when none is sent (bulk Create PR), with the task title as fallback', async () => {
    suggestPRTitleForWorktree.mockClear();
    createPR.mockResolvedValue({ success: true, prUrl: PR_URL, alreadyExists: false });
    const handler = await createPrHandler();

    await handler({}, 't1');

    expect(suggestPRTitleForWorktree).not.toHaveBeenCalled();
    expect(createPR.mock.calls.at(-1)?.[0].title).toBeUndefined();
  });

  it('falls back to the spec id only when there is no task title', async () => {
    createPR.mockResolvedValue({ success: true, prUrl: PR_URL, alreadyExists: false });
    const handler = await createPrHandler();

    await handler({}, 't1');

    expect(createPR.mock.calls.at(-1)?.[0].fallbackTitle).toBe('auto-claude: 001-x');
  });

  it('never asks for a suggestion when the person typed a title', async () => {
    suggestPRTitleForWorktree.mockClear();
    createPR.mockResolvedValue({ success: true, prUrl: PR_URL, alreadyExists: false });
    const handler = await createPrHandler();

    await handler({}, 't1', { title: 'My own title' });

    expect(suggestPRTitleForWorktree).not.toHaveBeenCalled();
    expect(createPR.mock.calls.at(-1)?.[0].title).toBe('My own title');
  });

  // zeenha fork: task 095 was stopped after 1 of 29 subtasks, and Create PR
  // told the person to mark it done. createPR needs the plan's progress to
  // say "resume it" instead (pr-creator.test.ts).
  describe('subtask progress', () => {
    const plan = (statuses: string[]) =>
      JSON.stringify({ phases: [{ subtasks: statuses.map((status, i) => ({ id: `${i}`, status })) }] });
    const worktreePlan = () => path.join(ref.worktree, '.auto-claude', 'specs', '001-x', 'implementation_plan.json');

    it("passes the worktree plan's counts, which the coder keeps current", async () => {
      fs.writeFileSync(specFile('implementation_plan.json'), plan(['pending', 'pending', 'pending']));
      fs.mkdirSync(path.dirname(worktreePlan()), { recursive: true });
      fs.writeFileSync(worktreePlan(), plan(['completed', 'pending', 'pending']));
      createPR.mockResolvedValue({ success: false, noChanges: true, error: 'x' });
      const handler = await createPrHandler();

      await handler({}, 't1');

      expect(createPR.mock.calls.at(-1)?.[0].subtaskProgress).toEqual({ completed: 1, total: 3 });
    });

    it("falls back to the project's plan when the worktree's has no subtasks", async () => {
      fs.writeFileSync(specFile('implementation_plan.json'), plan(['completed', 'completed']));
      fs.mkdirSync(path.dirname(worktreePlan()), { recursive: true });
      fs.writeFileSync(worktreePlan(), JSON.stringify({ phases: [] }));
      createPR.mockResolvedValue({ success: true, prUrl: PR_URL, alreadyExists: false });
      const handler = await createPrHandler();

      await handler({}, 't1');

      expect(createPR.mock.calls.at(-1)?.[0].subtaskProgress).toEqual({ completed: 2, total: 2 });
    });

    it('passes nothing when no plan has subtasks', async () => {
      createPR.mockResolvedValue({ success: true, prUrl: PR_URL, alreadyExists: false });
      const handler = await createPrHandler();

      await handler({}, 't1');

      expect(createPR.mock.calls.at(-1)?.[0].subtaskProgress).toBeUndefined();
    });
  });
});
