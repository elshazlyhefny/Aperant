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
    task: { id: 't1', specId: '001-x' },
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
  const { registerWorktreeHandlers } = await import('../worktree-handlers');
  registerWorktreeHandlers(() => null);
  const fn = handlers.get(IPC_CHANNELS.TASK_WORKTREE_CREATE_PR);
  if (!fn) throw new Error('TASK_WORKTREE_CREATE_PR handler was not registered');
  return fn as (e: unknown, taskId: string, options?: Record<string, unknown>) => Promise<{
    success: boolean;
    data?: { success: boolean; prUrl?: string; alreadyExists?: boolean };
  }>;
}

describe('Create PR when the PR already exists (zeenha fork)', () => {
  beforeEach(() => {
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
  it('uses the AI title when no title is sent (bulk Create PR)', async () => {
    suggestPRTitleForWorktree.mockResolvedValueOnce('feat(shop): add View cart link');
    createPR.mockResolvedValue({ success: true, prUrl: PR_URL, alreadyExists: false });
    const handler = await createPrHandler();

    await handler({}, 't1');

    expect(createPR.mock.calls.at(-1)?.[0].title).toBe('feat(shop): add View cart link');
  });

  it('falls back to the spec id only when there is neither a suggestion nor a task title', async () => {
    createPR.mockResolvedValue({ success: true, prUrl: PR_URL, alreadyExists: false });
    const handler = await createPrHandler();

    await handler({}, 't1');

    expect(createPR.mock.calls.at(-1)?.[0].title).toBe('auto-claude: 001-x');
  });

  it('never asks for a suggestion when the person typed a title', async () => {
    suggestPRTitleForWorktree.mockClear();
    createPR.mockResolvedValue({ success: true, prUrl: PR_URL, alreadyExists: false });
    const handler = await createPrHandler();

    await handler({}, 't1', { title: 'My own title' });

    expect(suggestPRTitleForWorktree).not.toHaveBeenCalled();
    expect(createPR.mock.calls.at(-1)?.[0].title).toBe('My own title');
  });
});
