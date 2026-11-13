/**
 * zeenha fork: when a PR for the task's own branch already exists (a lost
 * reply on the first attempt, or Create PR again after the merge queue sent
 * it back), the task must still record it. Before the fix the task stayed in
 * Human Review with no PR link, and every later click said "already exists".
 */
import { execFileSync } from 'child_process';
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

const ref = vi.hoisted(() => ({ path: '', worktree: '', settings: {} as Record<string, unknown>, noTask: false }));
vi.mock('../shared', () => ({
  findTaskAndProject: () => ({
    task: ref.noTask ? undefined : { id: 't1', specId: '001-x', status: 'human_review', reviewReason: 'completed' },
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
const createMR = vi.hoisted(() => vi.fn());
const createBitbucketPR = vi.hoisted(() => vi.fn());
vi.mock('../../../ai/runners/github/pr-creator', () => ({
  createPR,
  createMR,
  createBitbucketPR,
  suggestPRTitleForWorktree,
}));
const getGitLabConfig = vi.hoisted(() => vi.fn(async () => null as unknown));
vi.mock('../../gitlab/utils', () => ({ getGitLabConfig }));
const getBitbucketConfig = vi.hoisted(() => vi.fn(async () => null as unknown));
vi.mock('../../bitbucket/utils', () => ({ getBitbucketConfig }));

const PR_URL = 'https://github.com/owner/repo/pull/7';

function setOrigin(url: string) {
  execFileSync('git', ['init', '-q'], { cwd: ref.path });
  execFileSync('git', ['remote', 'add', 'origin', url], { cwd: ref.path });
}

function specFile(name: string) {
  return path.join(ref.path, '.auto-claude', 'specs', '001-x', name);
}

async function createPrHandler() {
  registerWorktreeHandlers(() => null);
  const fn = handlers.get(IPC_CHANNELS.TASK_WORKTREE_CREATE_PR);
  if (!fn) throw new Error('TASK_WORKTREE_CREATE_PR handler was not registered');
  return fn as (e: unknown, taskId: string, options?: Record<string, unknown>) => Promise<{
    success: boolean;
    error?: string;
    data?: { success: boolean; prUrl?: string; alreadyExists?: boolean; errorCode?: string };
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
    createMR.mockReset();
    getGitLabConfig.mockReset();
    getGitLabConfig.mockResolvedValue(null);
    createBitbucketPR.mockReset();
    getBitbucketConfig.mockReset();
    getBitbucketConfig.mockResolvedValue(null);
    ref.path = fs.mkdtempSync(path.join(os.tmpdir(), 'create-pr-'));
    ref.worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'create-pr-wt-'));
    ref.settings = {};
    ref.noTask = false;
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

  // zeenha fork: GitLab merge requests
  describe('GitLab provider', () => {
    const MR_URL = 'https://gitlab.example.com/group/repo/-/merge_requests/3';
    const gitlab = { token: 't', instanceUrl: 'https://gitlab.example.com', project: 'group/repo' };

    it('opens a merge request when GitLab is configured and origin matches', async () => {
      setOrigin('git@gitlab.example.com:group/repo.git');
      getGitLabConfig.mockResolvedValue(gitlab);
      createMR.mockResolvedValue({ success: true, prUrl: MR_URL, alreadyExists: false });

      const result = await (await createPrHandler())({}, 't1');

      expect(createPR).not.toHaveBeenCalled();
      expect(createMR.mock.calls[0][0].gitlab).toEqual(gitlab);
      expect(createMR.mock.calls[0][0].ghPath).toBeUndefined();
      expect(result.data).toMatchObject({ success: true, prUrl: MR_URL });
      expect(JSON.parse(fs.readFileSync(specFile('task_metadata.json'), 'utf-8')).prUrl).toBe(MR_URL);
      expect(JSON.parse(fs.readFileSync(specFile('implementation_plan.json'), 'utf-8')).status).toBe('done');
    });

    it('still opens a GitHub PR when origin is on another host', async () => {
      setOrigin('git@github.com:owner/repo.git');
      getGitLabConfig.mockResolvedValue(gitlab);
      createPR.mockResolvedValue({ success: true, prUrl: PR_URL, alreadyExists: false });

      await (await createPrHandler())({}, 't1');

      expect(createMR).not.toHaveBeenCalled();
      expect(createPR).toHaveBeenCalledTimes(1);
    });

    it('opens a GitHub PR when GitLab is not configured', async () => {
      setOrigin('git@gitlab.example.com:group/repo.git');
      createPR.mockResolvedValue({ success: true, prUrl: PR_URL, alreadyExists: false });

      await (await createPrHandler())({}, 't1');

      expect(createMR).not.toHaveBeenCalled();
      expect(createPR).toHaveBeenCalledTimes(1);
    });

    it('surfaces a createMR failure code', async () => {
      setOrigin('https://gitlab.example.com/group/repo.git');
      getGitLabConfig.mockResolvedValue(gitlab);
      createMR.mockResolvedValue({ success: false, errorCode: 'MR_FAILED', error: 'nope' });

      const result = await (await createPrHandler())({}, 't1');

      expect(result.success).toBe(false);
      expect(result.error).toBe('nope');
      expect(result.data?.errorCode).toBe('MR_FAILED');
    });
  });

  describe('Bitbucket provider', () => {
    const BB_URL = 'https://bitbucket.org/ws/repo/pull-requests/4';
    const bitbucket = { token: 't', workspace: 'ws', repoSlug: 'repo' };

    it('opens a pull request via Bitbucket when configured and origin matches', async () => {
      setOrigin('git@bitbucket.org:ws/repo.git');
      getBitbucketConfig.mockResolvedValue(bitbucket);
      createBitbucketPR.mockResolvedValue({ success: true, prUrl: BB_URL, alreadyExists: false });

      const result = await (await createPrHandler())({}, 't1');

      expect(createPR).not.toHaveBeenCalled();
      expect(createMR).not.toHaveBeenCalled();
      expect(createBitbucketPR.mock.calls[0][0].bitbucket).toEqual(bitbucket);
      expect(createBitbucketPR.mock.calls[0][0].ghPath).toBeUndefined();
      expect(result.data).toMatchObject({ success: true, prUrl: BB_URL });
      expect(JSON.parse(fs.readFileSync(specFile('task_metadata.json'), 'utf-8')).prUrl).toBe(BB_URL);
      expect(JSON.parse(fs.readFileSync(specFile('implementation_plan.json'), 'utf-8')).status).toBe('done');
    });

    it('works for an https origin with a user', async () => {
      setOrigin('https://user@bitbucket.org/ws/repo.git');
      getBitbucketConfig.mockResolvedValue(bitbucket);
      createBitbucketPR.mockResolvedValue({ success: true, prUrl: BB_URL, alreadyExists: false });

      await (await createPrHandler())({}, 't1');

      expect(createBitbucketPR).toHaveBeenCalledTimes(1);
      expect(createPR).not.toHaveBeenCalled();
    });

    it('still uses gh when origin is github.com', async () => {
      setOrigin('git@github.com:owner/repo.git');
      getBitbucketConfig.mockResolvedValue(bitbucket);
      createPR.mockResolvedValue({ success: true, prUrl: PR_URL, alreadyExists: false });

      await (await createPrHandler())({}, 't1');

      expect(createBitbucketPR).not.toHaveBeenCalled();
      expect(createPR).toHaveBeenCalledTimes(1);
    });

    it('uses gh when Bitbucket is not configured', async () => {
      setOrigin('git@bitbucket.org:ws/repo.git');
      createPR.mockResolvedValue({ success: true, prUrl: PR_URL, alreadyExists: false });

      await (await createPrHandler())({}, 't1');

      expect(createBitbucketPR).not.toHaveBeenCalled();
      expect(createPR).toHaveBeenCalledTimes(1);
    });

    it('does not use Bitbucket for a gitlab.example.com origin', async () => {
      setOrigin('git@gitlab.example.com:group/repo.git');
      getBitbucketConfig.mockResolvedValue(bitbucket);
      createPR.mockResolvedValue({ success: true, prUrl: PR_URL, alreadyExists: false });

      await (await createPrHandler())({}, 't1');

      expect(createBitbucketPR).not.toHaveBeenCalled();
      expect(createPR).toHaveBeenCalledTimes(1);
    });

    it('wins over GitLab when both are configured and origin is bitbucket.org', async () => {
      setOrigin('git@bitbucket.org:ws/repo.git');
      getBitbucketConfig.mockResolvedValue(bitbucket);
      getGitLabConfig.mockResolvedValue({ token: 't', instanceUrl: 'https://gitlab.example.com', project: 'g/r' });
      createBitbucketPR.mockResolvedValue({ success: true, prUrl: BB_URL, alreadyExists: false });

      await (await createPrHandler())({}, 't1');

      expect(createBitbucketPR).toHaveBeenCalledTimes(1);
      expect(createMR).not.toHaveBeenCalled();
      expect(createPR).not.toHaveBeenCalled();
    });

    it('surfaces an MR_FAILED failure', async () => {
      setOrigin('git@bitbucket.org:ws/repo.git');
      getBitbucketConfig.mockResolvedValue(bitbucket);
      createBitbucketPR.mockResolvedValue({ success: false, errorCode: 'MR_FAILED', error: 'nope' });

      const result = await (await createPrHandler())({}, 't1');

      expect(result.success).toBe(false);
      expect(result.error).toBe('nope');
      expect(result.data?.errorCode).toBe('MR_FAILED');
    });

    it('records alreadyExists with a URL as done', async () => {
      setOrigin('git@bitbucket.org:ws/repo.git');
      getBitbucketConfig.mockResolvedValue(bitbucket);
      createBitbucketPR.mockResolvedValue({ success: true, prUrl: BB_URL, alreadyExists: true });

      const result = await (await createPrHandler())({}, 't1');

      expect(result.data).toMatchObject({ success: true, prUrl: BB_URL, alreadyExists: true });
      expect(JSON.parse(fs.readFileSync(specFile('task_metadata.json'), 'utf-8')).prUrl).toBe(BB_URL);
      expect(JSON.parse(fs.readFileSync(specFile('implementation_plan.json'), 'utf-8')).status).toBe('done');
    });
  });

  describe('error codes', () => {
    it('TASK_NOT_FOUND', async () => {
      ref.noTask = true;
      const result = await (await createPrHandler())({}, 't1');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Task not found');
      expect(result.data?.errorCode).toBe('TASK_NOT_FOUND');
    });

    it('SPEC_DIR_NOT_FOUND', async () => {
      fs.rmSync(path.join(ref.path, '.auto-claude', 'specs', '001-x'), { recursive: true, force: true });
      const result = await (await createPrHandler())({}, 't1');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Spec directory not found');
      expect(result.data?.errorCode).toBe('SPEC_DIR_NOT_FOUND');
    });

    it('NO_WORKTREE', async () => {
      ref.worktree = '';
      const result = await (await createPrHandler())({}, 't1');
      expect(result.success).toBe(false);
      expect(result.error).toBe('No worktree found for this task');
      expect(result.data?.errorCode).toBe('NO_WORKTREE');
    });

    it('INVALID_TARGET_BRANCH', async () => {
      const result = await (await createPrHandler())({}, 't1', { targetBranch: 'bad branch name' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid target branch name');
      expect(result.data?.errorCode).toBe('INVALID_TARGET_BRANCH');
    });

    it('INVALID_TITLE_LENGTH', async () => {
      const result = await (await createPrHandler())({}, 't1', { title: 'a'.repeat(5000) });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/exceeds maximum length/);
      expect(result.data?.errorCode).toBe('INVALID_TITLE_LENGTH');
    });

    it('INVALID_TITLE_CHARS', async () => {
      const result = await (await createPrHandler())({}, 't1', { title: 'bad\u0000title' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('PR title contains invalid characters');
      expect(result.data?.errorCode).toBe('INVALID_TITLE_CHARS');
    });

    it.each(['NO_CHANGES', 'BRANCH_REFUSED', 'COMMIT_FAILED', 'PUSH_FAILED', 'GH_TIMEOUT', 'GH_FAILED', 'RETRIES_EXHAUSTED'])(
      'passes through %s from createPR',
      async (code) => {
        createPR.mockResolvedValue({ success: false, errorCode: code, error: `msg ${code}` });
        const result = await (await createPrHandler())({}, 't1');
        expect(result.success).toBe(false);
        expect(result.error).toBe(`msg ${code}`);
        expect(result.data?.errorCode).toBe(code);
      }
    );

    it('maps a createPR failure without a code to UNKNOWN', async () => {
      createPR.mockResolvedValue({ success: false, error: 'boom' });
      const result = await (await createPrHandler())({}, 't1');
      expect(result.error).toBe('boom');
      expect(result.data?.errorCode).toBe('UNKNOWN');
    });

    it('maps a thrown exception to UNKNOWN', async () => {
      createPR.mockRejectedValue(new Error('exploded'));
      const result = await (await createPrHandler())({}, 't1');
      expect(result.success).toBe(false);
      expect(result.error).toBe('exploded');
      expect(result.data?.errorCode).toBe('UNKNOWN');
    });
  });
});
