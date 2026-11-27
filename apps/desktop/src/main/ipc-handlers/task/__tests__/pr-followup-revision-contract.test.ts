/**
 * zeenha fork: exercise the same reviewed-revision contract at dispatch and
 * publish through the real forge registry and URL parsers for every code host.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../../shared/constants';
import type { PRFeedbackResult, Project, StartPRFollowUpResult, Task } from '../../../../shared/types';
import { fetchAzureDevOpsPRFeedback } from '../../azuredevops/pr-feedback';
import { fetchBitbucketPRFeedback } from '../../bitbucket/pr-feedback';
import { fetchPRFeedback } from '../../github/pr/task-feedback';
import { fetchMRFeedback } from '../../gitlab/mr-feedback';
import { createDefaultFinalizerDeps, finalizePRFollowUp, type PRFollowUpFinalizerDeps } from '../pr-followup-finalizer';
import { registerPRFollowUpHandlers, type PRFollowUpIPCResult } from '../pr-followup-handlers';

const TASK_ID = 't1';
const PROJECT_ID = 'p1';
const SPEC_ID = '001-x';
const BRANCH = `auto-claude/${SPEC_ID}`;
const PUSH_URL = 'https://example.test/o/r.git';
const REVIEWED_FULL = 'a'.repeat(40);
const LOCAL_HEAD = 'b'.repeat(40);
const PRIOR_SIGNOFF = { status: 'approved', at: 'previous run' };

const handlers = vi.hoisted(() => new Map<string, Parameters<IpcMain['handle']>[1]>());
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Parameters<IpcMain['handle']>[1]) => handlers.set(channel, handler),
    on: vi.fn(),
  },
  app: { getPath: () => os.tmpdir(), isPackaged: false, on: vi.fn() },
}));

let task: Task;
let project: Project;
let worktree: string;
let specDir: string;

vi.mock('../shared', () => ({ findTaskAndProject: () => ({ task, project }) }));
vi.mock('../../../worktree-paths', () => ({ findTaskWorktree: () => worktree }));
vi.mock('../../../cli-tool-manager', () => ({ getToolPath: (tool: string) => tool }));
vi.mock('../../../utils/git-isolation', () => ({ getIsolatedGitEnv: () => ({}) }));
vi.mock('child_process', async (original) => ({
  ...(await original<typeof import('child_process')>()),
  execFileSync: (_file: string, args: string[]) => {
    switch (args.join(' ')) {
      case 'rev-parse --abbrev-ref HEAD':
        return `${BRANCH}\n`;
      case 'remote get-url --push origin':
        return `${PUSH_URL}\n`;
      default:
        throw new Error(`Unexpected git command: ${args.join(' ')}`);
    }
  },
}));
vi.mock('../../../claude-profile-manager', () => ({
  initializeClaudeProfileManager: async () => ({ hasValidAuth: () => true }),
}));

const stateManager = vi.hoisted(() => ({
  prepareForRestart: vi.fn(),
  startPRFollowUp: vi.fn(),
  clearTask: vi.fn(),
}));
vi.mock('../../../task-state-manager', () => ({ taskStateManager: stateManager }));

// Stub config lookup and API fetches, not URL parsing, forge adapters, or routing.
vi.mock(import('../../github/utils'), async (original) => ({
  ...(await original()),
  getGitHubConfig: () => ({ token: 'test-token', repo: 'o/r' }),
}));
vi.mock(import('../../github/pr/task-feedback'), async (original) => ({
  ...(await original()),
  fetchPRFeedback: vi.fn<typeof fetchPRFeedback>(),
}));
vi.mock(import('../../gitlab/utils'), async (original) => ({
  ...(await original()),
  getGitLabConfig: async () => ({ token: 'test-token', instanceUrl: 'https://gitlab.com', project: 'g/r' }),
}));
vi.mock(import('../../gitlab/mr-feedback'), async (original) => ({
  ...(await original()),
  fetchMRFeedback: vi.fn<typeof fetchMRFeedback>(),
}));
vi.mock(import('../../bitbucket/utils'), async (original) => ({
  ...(await original()),
  getBitbucketConfig: async () => ({ username: 'test-user', token: 'test-token', repository: 'ws/repo' }),
}));
vi.mock(import('../../bitbucket/pr-feedback'), async (original) => ({
  ...(await original()),
  fetchBitbucketPRFeedback: vi.fn<typeof fetchBitbucketPRFeedback>(),
}));
vi.mock(import('../../azuredevops/utils'), async (original) => ({
  ...(await original()),
  getAzureDevOpsConfig: async () => ({ organization: 'org', project: 'proj', repository: 'repo', pat: 'test-token' }),
}));
vi.mock(import('../../azuredevops/pr-feedback'), async (original) => ({
  ...(await original()),
  fetchAzureDevOpsPRFeedback: vi.fn<typeof fetchAzureDevOpsPRFeedback>(),
}));

const providers = [
  {
    name: 'GitHub',
    prUrl: 'https://github.com/o/r/pull/7',
    itemId: 'check:github-1',
    shownHead: REVIEWED_FULL,
    fetchFeedback: vi.mocked(fetchPRFeedback),
  },
  {
    name: 'GitLab',
    prUrl: 'https://gitlab.com/g/r/-/merge_requests/7',
    itemId: 'check:gitlab-1',
    shownHead: REVIEWED_FULL,
    fetchFeedback: vi.mocked(fetchMRFeedback),
  },
  {
    name: 'Bitbucket Cloud',
    prUrl: 'https://bitbucket.org/ws/repo/pull-requests/7',
    itemId: 'check:bitbucket-1',
    shownHead: REVIEWED_FULL.slice(0, 12),
    fetchFeedback: vi.mocked(fetchBitbucketPRFeedback),
  },
  {
    name: 'Azure DevOps',
    prUrl: 'https://dev.azure.com/org/proj/_git/repo/pullrequest/7',
    itemId: 'check:azure-1',
    shownHead: REVIEWED_FULL,
    fetchFeedback: vi.mocked(fetchAzureDevOpsPRFeedback),
  },
];

const agentManager = {
  isRunning: vi.fn(() => false),
  startQAProcess: vi.fn(async () => undefined),
};
const event = {} as IpcMainInvokeEvent;
function invoke<T>(channel: string, ...args: unknown[]): Promise<PRFollowUpIPCResult<T>> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`IPC handler not registered: ${channel}`);
  return handler(event, TASK_ID, ...args) as Promise<PRFollowUpIPCResult<T>>;
}
const get = () => invoke<PRFeedbackResult>(IPC_CHANNELS.TASK_PR_FEEDBACK_GET);
const start = (itemId: string, head: string | undefined) =>
  invoke<StartPRFollowUpResult>(IPC_CHANNELS.TASK_PR_FOLLOWUP_START, [itemId], head);
const markerPath = () => path.join(specDir, 'PR_FOLLOWUP.json');
const planPath = () => path.join(specDir, 'implementation_plan.json');

function expectNothingStarted() {
  expect(fs.existsSync(markerPath())).toBe(false);
  expect(fs.existsSync(path.join(specDir, 'QA_FIX_REQUEST.md'))).toBe(false);
  expect(agentManager.startQAProcess).not.toHaveBeenCalled();
  expect(stateManager.startPRFollowUp).not.toHaveBeenCalled();
}

function publishDeps(reviewedHead: string) {
  // Read the actual IPC marker; simulate QA writing a fresh approved signoff.
  const files = new Map([
    [markerPath(), fs.readFileSync(markerPath(), 'utf-8')],
    [planPath(), JSON.stringify({ qa_signoff: { status: 'approved', at: 'follow-up run' } })],
  ]);
  const ref = `refs/heads/${BRANCH}`;
  const gitResponses = new Map([
    ['rev-parse --abbrev-ref HEAD', `${BRANCH}\n`],
    ['rev-parse HEAD', `${LOCAL_HEAD}\n`],
    [`rev-parse --verify ${reviewedHead}^{commit}`, `${REVIEWED_FULL}\n`],
    [`merge-base --is-ancestor ${REVIEWED_FULL} HEAD`, ''],
    ['status --porcelain', ''],
    ['remote get-url --push origin', `${PUSH_URL}\n`],
    [`ls-remote origin ${ref}`, `${REVIEWED_FULL}\t${ref}\n`],
  ]);
  const pushFastForward = vi.fn<PRFollowUpFinalizerDeps['pushFastForward']>().mockResolvedValue({ ok: true });
  return {
    ...createDefaultFinalizerDeps(vi.fn()),
    readFile: (file: string) => files.get(file) ?? null,
    writeFile: (file: string, contents: string) => void files.set(file, contents),
    findWorktree: () => worktree,
    git: async (args: string[]) => {
      const command = args.join(' ');
      const response = gitResponses.get(command);
      if (response === undefined) throw new Error(`Unexpected git command: ${command}`);
      return response;
    },
    pushFastForward,
    persistPRDone: vi.fn<PRFollowUpFinalizerDeps['persistPRDone']>().mockResolvedValue(undefined),
    markDone: vi.fn(),
  } satisfies PRFollowUpFinalizerDeps;
}

describe.each(providers)('$name reviewed-revision contract', ({ prUrl, itemId, shownHead, fetchFeedback }) => {
  function setHead(headSha: string) {
    fetchFeedback.mockResolvedValue({
      prNumber: 7,
      prUrl,
      prState: 'open',
      headRef: BRANCH,
      headSha,
      checks: [{ id: itemId, kind: 'check', title: 'Build', summary: 'Build failed', truncated: false }],
      threads: [],
      reviews: [],
    });
  }

  const changedHead = 'c'.repeat(shownHead.length);

  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    for (const provider of providers) provider.fetchFeedback.mockReset();
    setHead(shownHead);
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-followup-contract-'));
    project = { id: PROJECT_ID, path: worktree, autoBuildPath: '.auto-claude' } as Project;
    task = { id: TASK_ID, projectId: PROJECT_ID, specId: SPEC_ID, status: 'pr_created', metadata: { prUrl } } as Task;
    fs.mkdirSync(path.join(worktree, '.git'));
    specDir = path.join(worktree, '.auto-claude', 'specs', SPEC_ID);
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(planPath(), JSON.stringify({ qa_signoff: PRIOR_SIGNOFF }));
    registerPRFollowUpHandlers(agentManager as never);
  });

  afterEach(() => fs.rmSync(worktree, { recursive: true, force: true }));

  describe('dispatch', () => {
    it('starts on the shown revision and records the previous QA approval', async () => {
      const feedback = await get();
      expect(feedback).toMatchObject({
        success: true,
        data: { headSha: shownHead, canStartFollowUp: true, checks: [{ id: itemId }] },
      });
      expect(await start(itemId, feedback.data?.headSha)).toEqual({ success: true, data: { started: true, itemCount: 1 } });
      expect(agentManager.startQAProcess).toHaveBeenCalledExactlyOnceWith(TASK_ID, worktree, SPEC_ID, PROJECT_ID);
      expect(JSON.parse(fs.readFileSync(markerPath(), 'utf-8'))).toMatchObject({
        reviewedHeadSha: shownHead,
        status: 'running',
        qaSignoffBefore: JSON.stringify(PRIOR_SIGNOFF),
      });
    });

    it('refuses a changed revision even when the same item still exists', async () => {
      const feedback = await get();
      expect(feedback.data?.headSha).toBe(shownHead);
      setHead(changedHead);
      expect(await start(itemId, feedback.data?.headSha)).toMatchObject({ success: false, code: 'head_changed' });
      expectNothingStarted();
    });

    it('blocks feedback and refuses to start when the current revision is unavailable', async () => {
      setHead('');
      expect(await get()).toMatchObject({
        success: true,
        data: { headSha: '', canStartFollowUp: false, blockedReason: 'head_unverified' },
      });
      expect(await start(itemId, shownHead)).toMatchObject({ success: false, code: 'head_unverified' });
      expectNothingStarted();
    });
  });

  describe('publish', () => {
    let deps: ReturnType<typeof publishDeps>;
    const finalize = () => finalizePRFollowUp({ taskId: TASK_ID, exitCode: 0, project, task, deps });

    beforeEach(async () => {
      expect(await start(itemId, shownHead)).toMatchObject({ success: true });
      deps = publishDeps(shownHead);
      fetchFeedback.mockClear();
    });

    it('does not push when the PR head differs from the reviewed revision', async () => {
      setHead(changedHead);
      expect(await finalize()).toMatchObject({ status: 'stale', reason: expect.stringContaining('revision changed') });
      expect(fetchFeedback).toHaveBeenCalledTimes(1);
      expect(deps.pushFastForward).not.toHaveBeenCalled();
    });

    it('does not push when the PR head is unavailable', async () => {
      setHead('');
      expect(await finalize()).toMatchObject({ status: 'stale', reason: expect.stringContaining('Could not verify') });
      expect(fetchFeedback).toHaveBeenCalledTimes(1);
      expect(deps.pushFastForward).not.toHaveBeenCalled();
    });

    it('pushes an unchanged revision using the full remote SHA', async () => {
      expect(await finalize()).toMatchObject({ status: 'pushed', headSha: LOCAL_HEAD });
      expect(fetchFeedback).toHaveBeenCalledTimes(1);
      expect(deps.pushFastForward).toHaveBeenCalledExactlyOnceWith(worktree, BRANCH, REVIEWED_FULL);
    });
  });
});
