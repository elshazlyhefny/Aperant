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
const createAzureDevOpsPR = vi.hoisted(() => vi.fn());
vi.mock('../../../ai/runners/github/pr-creator', () => ({
  createPR,
  createMR,
  createBitbucketPR,
  createAzureDevOpsPR,
  suggestPRTitleForWorktree,
}));
const getGitLabConfig = vi.hoisted(() => vi.fn(async () => null as unknown));
vi.mock('../../gitlab/utils', () => ({ getGitLabConfig }));
const getBitbucketConfig = vi.hoisted(() => vi.fn(async () => null as unknown));
vi.mock('../../bitbucket/utils', () => ({ getBitbucketConfig }));

const getAzureDevOpsConfig = vi.hoisted(() => vi.fn(async () => null as unknown));
vi.mock('../../azuredevops/utils', async () => ({
  ...(await vi.importActual<typeof import('../../azuredevops/utils')>('../../azuredevops/utils')),
  getAzureDevOpsConfig,
}));

const AZURE_CONFIG = { organization: 'org', project: 'proj', repository: 'repo', pat: 'p' };
const PR_URL = 'https://dev.azure.com/org/proj/_git/repo/pullrequest/3';

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
  return fn as (e: unknown, taskId: string, options?: Record<string, unknown>) => Promise<unknown>;
}

/** zeenha fork: Create PR opens an Azure DevOps pull request only for a matching Azure remote. */
describe('Create PR routing for Azure DevOps (zeenha fork)', () => {
  beforeEach(() => {
    taskStateManager.clearTask('t1');
    handlers.clear();
    for (const fn of [createPR, createMR, createBitbucketPR, createAzureDevOpsPR]) fn.mockReset();
    createPR.mockResolvedValue({ success: true, prUrl: 'https://github.com/o/r/pull/1', alreadyExists: false });
    createAzureDevOpsPR.mockResolvedValue({ success: true, prUrl: PR_URL, alreadyExists: false });
    getGitLabConfig.mockResolvedValue(null);
    getBitbucketConfig.mockResolvedValue(null);
    getAzureDevOpsConfig.mockResolvedValue(AZURE_CONFIG);
    ref.path = fs.mkdtempSync(path.join(os.tmpdir(), 'create-pr-az-'));
    ref.worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'create-pr-az-wt-'));
    ref.settings = {};
    ref.noTask = false;
    fs.mkdirSync(path.dirname(specFile('x')), { recursive: true });
    fs.writeFileSync(specFile('implementation_plan.json'), JSON.stringify({ status: 'human_review', phases: [] }));
    fs.writeFileSync(specFile('task_metadata.json'), JSON.stringify({}));
  });

  it('opens an Azure DevOps PR for a matching Azure remote', async () => {
    setOrigin('https://org@dev.azure.com/org/proj/_git/repo');
    const handler = await createPrHandler();
    await handler({}, 't1');
    expect(createAzureDevOpsPR).toHaveBeenCalledTimes(1);
    expect(createAzureDevOpsPR.mock.calls[0][0].azureDevOps).toEqual(AZURE_CONFIG);
    expect(createPR).not.toHaveBeenCalled();
  });

  it('opens a gh PR when origin is on GitHub, even with Azure configured', async () => {
    setOrigin('https://github.com/o/r.git');
    const handler = await createPrHandler();
    await handler({}, 't1');
    expect(createAzureDevOpsPR).not.toHaveBeenCalled();
    expect(createPR).toHaveBeenCalledTimes(1);
  });

  it('opens a gh PR when the Azure remote is a different repository', async () => {
    setOrigin('https://org@dev.azure.com/org/proj/_git/other');
    const handler = await createPrHandler();
    await handler({}, 't1');
    expect(createAzureDevOpsPR).not.toHaveBeenCalled();
    expect(createPR).toHaveBeenCalledTimes(1);
  });
});
