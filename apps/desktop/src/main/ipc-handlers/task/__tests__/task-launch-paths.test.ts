/**
 * Characterisation tests for the three places that launch a task agent:
 * TASK_START, applyTaskStatusUpdate (-> in_progress) and the TASK_RECOVER_STUCK
 * auto-restart. They pin what each path starts (spec creation vs task
 * execution), with which options, and which pre-flight failures stop it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../../shared/constants';
import { registerTaskExecutionHandlers } from '../execution-handlers';

const handlers = vi.hoisted(() => new Map<string, Function>());
vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: Function) => handlers.set(ch, fn),
    on: (ch: string, fn: Function) => handlers.set(ch, fn),
  },
  BrowserWindow: class {},
  shell: { openPath: vi.fn() },
  app: { getPath: () => os.tmpdir(), isPackaged: false, on: vi.fn() },
}));

// biome-ignore lint/suspicious/noExplicitAny: mutable test fixture
const ref = vi.hoisted(() => ({ task: {} as any, project: {} as any }));
vi.mock('../shared', () => ({
  findTaskAndProject: () => ({ task: ref.task, project: ref.project }),
}));

const machine = vi.hoisted(() => ({
  handleManualStatusChange: vi.fn(() => true),
  handleUiEvent: vi.fn(),
  prepareForRestart: vi.fn(),
  getCurrentState: vi.fn((): string | undefined => undefined),
}));
vi.mock('../../../task-state-manager', () => ({ taskStateManager: machine }));

vi.mock('../plan-file-utils', () => ({
  getPlanPath: () => '/nonexistent/implementation_plan.json',
  persistPlanStatus: vi.fn(async () => true),
  createPlanIfNotExists: vi.fn(async () => undefined),
  resetStuckSubtasks: vi.fn(async () => ({ success: true, resetCount: 0 })),
  hasPlanWithSubtasks: vi.fn(() => false),
}));

const worktree = vi.hoisted(() => ({ path: null as string | null }));
vi.mock('../../../worktree-paths', () => ({ findTaskWorktree: () => worktree.path }));
vi.mock('../../../project-store', () => ({
  projectStore: { invalidateTasksCache: vi.fn(), getProject: vi.fn() },
}));

const git = vi.hoisted(() => ({
  checkGitStatus: vi.fn((): { isGitRepo: boolean; hasCommits: boolean; error?: string } => ({
    isGitRepo: true,
    hasCommits: true,
  })),
}));
vi.mock('../../../project-initializer', () => ({ checkGitStatus: git.checkGitStatus }));

const watcher = vi.hoisted(() => ({
  watch: vi.fn(() => Promise.resolve()),
  unwatch: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../../file-watcher', () => ({ fileWatcher: watcher }));

const auth = vi.hoisted(() => ({
  hasValidAuth: vi.fn(() => true),
  init: vi.fn(),
}));
vi.mock('../../../claude-profile-manager', () => ({
  initializeClaudeProfileManager: auth.init,
}));

const settings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../../../settings-utils', () => ({ readSettingsFile: () => settings.value }));

vi.mock('../../../task-queue-manager', () => ({
  taskQueueManager: { requestProcess: vi.fn(), onTaskStatusChanged: vi.fn() },
}));
vi.mock('../../agent-events-handlers', () => ({ cancelFallbackTimer: vi.fn() }));

const running = vi.hoisted(() => ({ value: false }));
const agentManager = {
  isRunning: vi.fn(() => running.value),
  killTask: vi.fn(),
  startSpecCreation: vi.fn(),
  startTaskExecution: vi.fn(),
  startQAProcess: vi.fn(async (): Promise<void> => {
    running.value = true;
  }),
};
const mainWindow = { webContents: { send: vi.fn() } };

let specDir = '';

function writeSpec() {
  fs.writeFileSync(path.join(specDir, 'spec.md'), `# Spec\n\n${'A real specification line. '.repeat(10)}\n`);
}
function writeMetadata(baseBranch: string) {
  fs.writeFileSync(path.join(specDir, 'task_metadata.json'), JSON.stringify({ baseBranch }));
}
function writePlan(content: string | object) {
  fs.writeFileSync(
    path.join(specDir, 'implementation_plan.json'),
    typeof content === 'string' ? content : JSON.stringify(content)
  );
}
const PLAN_WITH_SUBTASKS = {
  phases: [{ subtasks: [{ id: 's1', status: 'pending' }] }],
};

function register() {
  // biome-ignore lint/suspicious/noExplicitAny: a minimal AgentManager stand-in
  registerTaskExecutionHandlers(agentManager as any, () => mainWindow as any);
}
async function startTask() {
  register();
  const fn = handlers.get(IPC_CHANNELS.TASK_START);
  if (!fn) throw new Error('TASK_START handler was not registered');
  await fn({}, 't1');
}
async function updateStatus(status: string) {
  register();
  const fn = handlers.get(IPC_CHANNELS.TASK_UPDATE_STATUS);
  if (!fn) throw new Error('TASK_UPDATE_STATUS handler was not registered');
  return (await fn({}, 't1', status)) as { success: boolean; error?: string };
}
async function recover() {
  register();
  const fn = handlers.get(IPC_CHANNELS.TASK_RECOVER_STUCK);
  if (!fn) throw new Error('TASK_RECOVER_STUCK handler was not registered');
  return (await fn({}, 't1', { autoRestart: true })) as {
    success: boolean;
    data?: { autoRestarted?: boolean; recovered?: boolean };
  };
}

function expectedOptions(baseBranch: string | undefined) {
  return {
    parallel: false,
    workers: 1,
    baseBranch,
    useWorktree: true,
    useLocalBranch: false,
    pushNewBranches: true,
  };
}
function errorsSent() {
  return mainWindow.webContents.send.mock.calls.filter((c) => c[0] === IPC_CHANNELS.TASK_ERROR);
}
function expectNothingStarted() {
  expect(agentManager.startSpecCreation).not.toHaveBeenCalled();
  expect(agentManager.startTaskExecution).not.toHaveBeenCalled();
}

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
  machine.getCurrentState.mockReturnValue(undefined);
  machine.handleManualStatusChange.mockReturnValue(true);
  git.checkGitStatus.mockReturnValue({ isGitRepo: true, hasCommits: true });
  auth.hasValidAuth.mockReturnValue(true);
  auth.init.mockResolvedValue({ hasValidAuth: auth.hasValidAuth });
  settings.value = {};
  worktree.path = null;
  running.value = false;
  watcher.watch.mockReturnValue(Promise.resolve());
  watcher.unwatch.mockReturnValue(Promise.resolve());

  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'task-launch-paths-'));
  specDir = path.join(projectPath, '.auto-claude', 'specs', '001-x');
  fs.mkdirSync(specDir, { recursive: true });
  ref.project = {
    id: 'p1',
    path: projectPath,
    autoBuildPath: '.auto-claude',
    settings: { mainBranch: 'main' },
  };
  ref.task = {
    id: 't1',
    specId: '001-x',
    projectId: 'p1',
    status: 'backlog',
    title: 'Title',
    description: 'Description',
    subtasks: [],
    specsPath: specDir,
    metadata: { useWorktree: true, useLocalBranch: false, pushNewBranches: true },
  };
});

describe('TASK_START launch', () => {
  it('starts spec creation when there is no spec.md', async () => {
    await startTask();
    expect(agentManager.startSpecCreation).toHaveBeenCalledWith(
      't1',
      ref.project.path,
      'Description',
      specDir,
      ref.task.metadata,
      'main',
      'p1'
    );
    expect(agentManager.startTaskExecution).not.toHaveBeenCalled();
    expect(watcher.watch).toHaveBeenCalledWith('t1', specDir);
  });

  it('falls back to the title when there is no description', async () => {
    ref.task.description = undefined;
    await startTask();
    expect(agentManager.startSpecCreation.mock.calls[0][2]).toBe('Title');
  });

  it.each([
    ['no plan', null],
    ['an empty plan file', ''],
    ['a corrupt plan file', '{not json'],
    ['a plan with phases but no subtasks', { phases: [{ subtasks: [] }] }],
  ])('starts task execution for a spec with %s', async (_label, plan) => {
    writeSpec();
    if (plan !== null) writePlan(plan);
    await startTask();
    expect(agentManager.startSpecCreation).not.toHaveBeenCalled();
    expect(agentManager.startTaskExecution).toHaveBeenCalledWith('t1', ref.project.path, '001-x', expectedOptions('main'), 'p1');
    expect(watcher.watch).toHaveBeenCalledWith('t1', specDir);
  });

  it('starts task execution for a spec with a plan that has subtasks', async () => {
    writeSpec();
    writePlan(PLAN_WITH_SUBTASKS);
    await startTask();
    expect(agentManager.startSpecCreation).not.toHaveBeenCalled();
    expect(agentManager.startTaskExecution).toHaveBeenCalledWith('t1', ref.project.path, '001-x', expectedOptions('main'), 'p1');
  });

  it('prefers the task-level baseBranch over the project mainBranch', async () => {
    writeMetadata('feature/base');
    writeSpec();
    await startTask();
    expect(agentManager.startTaskExecution.mock.calls[0][3]).toEqual(expectedOptions('feature/base'));
  });

  it('passes an origin/-prefixed baseBranch to startTaskExecution without the prefix', async () => {
    writeMetadata('origin/feat/x');
    writeSpec();
    await startTask();
    expect(agentManager.startTaskExecution.mock.calls[0][3]).toEqual(expectedOptions('feat/x'));
  });

  it('passes an origin/-prefixed baseBranch to startSpecCreation without the prefix', async () => {
    writeMetadata('origin/feat/x');
    await startTask();
    expect(agentManager.startSpecCreation.mock.calls[0][5]).toBe('feat/x');
  });

  describe('XState event choice', () => {
    const lastEvent = () => machine.handleUiEvent.mock.calls.at(-1)?.[1];

    it('error with no plan subtasks -> PLANNING_STARTED', async () => {
      ref.task.status = 'error';
      await startTask();
      expect(lastEvent()).toEqual({ type: 'PLANNING_STARTED' });
    });

    it('error with plan subtasks -> USER_RESUMED', async () => {
      ref.task.status = 'error';
      writeSpec();
      writePlan(PLAN_WITH_SUBTASKS);
      await startTask();
      expect(lastEvent()).toEqual({ type: 'USER_RESUMED' });
    });

    it('plan_review -> PLAN_APPROVED', async () => {
      ref.task.status = 'human_review';
      ref.task.reviewReason = 'plan_review';
      await startTask();
      expect(lastEvent()).toEqual({ type: 'PLAN_APPROVED' });
    });

    it('backlog -> PLANNING_STARTED', async () => {
      await startTask();
      expect(lastEvent()).toEqual({ type: 'PLANNING_STARTED' });
    });

    it('uses the live XState state when an actor exists', async () => {
      machine.getCurrentState.mockReturnValue('plan_review');
      await startTask();
      expect(lastEvent()).toEqual({ type: 'PLAN_APPROVED' });
    });
  });

  describe('pre-flight failures', () => {
    it('reports a project that is not a git repository', async () => {
      git.checkGitStatus.mockReturnValue({ isGitRepo: false, hasCommits: false });
      await startTask();
      expect(errorsSent()).toHaveLength(1);
      expectNothingStarted();
    });

    it('reports a repository without commits', async () => {
      git.checkGitStatus.mockReturnValue({ isGitRepo: true, hasCommits: false });
      await startTask();
      expect(errorsSent()).toHaveLength(1);
      expectNothingStarted();
    });

    it('reports missing authentication when there is no provider account', async () => {
      auth.hasValidAuth.mockReturnValue(false);
      await startTask();
      expect(errorsSent()).toHaveLength(1);
      expectNothingStarted();
    });

    it('reports a profile manager that fails to initialise', async () => {
      auth.init.mockRejectedValue(new Error('disk full'));
      await startTask();
      expect(errorsSent()).toHaveLength(1);
      expect(errorsSent()[0][2]).toContain('disk full');
      expectNothingStarted();
    });

    it('lets a provider account bypass hasValidAuth() = false', async () => {
      auth.hasValidAuth.mockReturnValue(false);
      settings.value = { providerAccounts: [{ id: 'a1' }] };
      await startTask();
      expect(errorsSent()).toHaveLength(0);
      expect(agentManager.startSpecCreation).toHaveBeenCalledTimes(1);
    });
  });
});

// zeenha fork: a "Request changes" or PR follow-up QA run that paused for an
// account (human_review / account_required) resumes as the same QA process. Going
// through launchTask ran the BuildOrchestrator, which saw the complete build with
// its old PASSED qa_report.md and dropped the request.
describe('TASK_START resume of an account-paused QA fix run', () => {
  const COMPLETE_PLAN = { phases: [{ subtasks: [{ id: 's1', status: 'completed' }] }] };
  const REQUEST_CHANGES = '# QA Fix Request\n\nStatus: REJECTED\n\n## Feedback\n\nMake the button blue\n';
  const lastEvent = () => machine.handleUiEvent.mock.calls.at(-1)?.[1];

  function pauseForAccount() {
    ref.task.status = 'human_review';
    ref.task.reviewReason = 'account_required';
    ref.task.metadata = { ...ref.task.metadata, phaseProviders: { qa: 'anthropic' } };
  }

  it('starts the QA process, not launchTask, when a Request-changes QA_FIX_REQUEST.md is pending', async () => {
    pauseForAccount();
    writeSpec();
    writePlan(COMPLETE_PLAN);
    fs.writeFileSync(path.join(specDir, 'QA_FIX_REQUEST.md'), REQUEST_CHANGES);

    await startTask();

    expect(agentManager.startQAProcess).toHaveBeenCalledWith('t1', ref.project.path, '001-x', 'p1');
    expectNothingStarted();
    expect(machine.prepareForRestart).toHaveBeenCalledWith('t1');
    expect(lastEvent()).toEqual({ type: 'USER_RESUMED' });
    // The request stays for QALoop's fixer
    expect(fs.existsSync(path.join(specDir, 'QA_FIX_REQUEST.md'))).toBe(true);
  });

  it('resumes a running PR follow-up as a QA process in the worktree and leaves its marker alone', async () => {
    pauseForAccount();
    writeSpec();
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'task-launch-paths-wt-'));
    worktree.path = wt;
    const wtSpecDir = path.join(wt, '.auto-claude', 'specs', '001-x');
    fs.mkdirSync(wtSpecDir, { recursive: true });
    fs.writeFileSync(path.join(wtSpecDir, 'implementation_plan.json'), JSON.stringify(COMPLETE_PLAN));
    const marker = JSON.stringify({ version: 1, prUrl: 'https://github.com/o/r/pull/1', status: 'running' });
    fs.writeFileSync(path.join(wtSpecDir, 'PR_FOLLOWUP.json'), marker);
    // No QA_FIX_REQUEST.md: the fixer already finished it and the re-review paused

    await startTask();

    expect(agentManager.startQAProcess).toHaveBeenCalledWith('t1', wt, '001-x', 'p1');
    expectNothingStarted();
    expect(fs.readFileSync(path.join(wtSpecDir, 'PR_FOLLOWUP.json'), 'utf-8')).toBe(marker);
  });

  it('leaves the task paused and reports the error when the QA process fails to start', async () => {
    pauseForAccount();
    writeSpec();
    writePlan(COMPLETE_PLAN);
    fs.writeFileSync(path.join(specDir, 'QA_FIX_REQUEST.md'), REQUEST_CHANGES);
    agentManager.startQAProcess.mockRejectedValueOnce(new Error('spawn failed'));

    await startTask();

    expect(machine.handleUiEvent).not.toHaveBeenCalled();
    expect(errorsSent()).toHaveLength(1);
    expect(errorsSent()[0][2]).toContain('spawn failed');
    expectNothingStarted();
  });

  it('leaves the task paused, without a second error, when startQAProcess declines to start', async () => {
    pauseForAccount();
    writeSpec();
    writePlan(COMPLETE_PLAN);
    fs.writeFileSync(path.join(specDir, 'QA_FIX_REQUEST.md'), REQUEST_CHANGES);
    // e.g. missing auth: the agent manager emits its own 'error' and returns
    agentManager.startQAProcess.mockResolvedValueOnce(undefined);

    await startTask();

    expect(machine.handleUiEvent).not.toHaveBeenCalled();
    expect(errorsSent()).toHaveLength(0);
  });

  describe('a PR follow-up whose fixer finished before the pause', () => {
    const OLD_APPROVAL = { status: 'approved', timestamp: '2026-01-01T00:00:00Z', issues_found: [] };

    function setUpFollowUp(signoff: Record<string, unknown>) {
      pauseForAccount();
      writeSpec();
      writePlan({ ...COMPLETE_PLAN, qa_signoff: signoff });
      fs.writeFileSync(
        path.join(specDir, 'PR_FOLLOWUP.json'),
        JSON.stringify({ status: 'running', qaSignoffBefore: JSON.stringify(OLD_APPROVAL) })
      );
    }
    const signoffNow = () =>
      JSON.parse(fs.readFileSync(path.join(specDir, 'implementation_plan.json'), 'utf-8')).qa_signoff;

    it("resets a qa_signoff still equal to the marker's qaSignoffBefore, so QALoop reviews instead of short-circuiting", async () => {
      setUpFollowUp(OLD_APPROVAL);

      await startTask();

      expect(agentManager.startQAProcess).toHaveBeenCalledTimes(1);
      expect(signoffNow().status).toBe('fixes_applied');
    });

    it('puts the original signoff back when QA fails to start', async () => {
      setUpFollowUp(OLD_APPROVAL);
      agentManager.startQAProcess.mockRejectedValueOnce(new Error('spawn failed'));

      await startTask();

      expect(signoffNow()).toEqual(OLD_APPROVAL);
      expect(machine.handleUiEvent).not.toHaveBeenCalled();
    });

    it('leaves a signoff the fixer already changed alone', async () => {
      const fixed = { status: 'fixes_applied', timestamp: '2026-02-02T00:00:00Z' };
      setUpFollowUp(fixed);

      await startTask();

      expect(agentManager.startQAProcess).toHaveBeenCalledTimes(1);
      expect(signoffNow()).toEqual(fixed);
    });

    it('leaves the signoff alone while the follow-up request is still pending', async () => {
      setUpFollowUp(OLD_APPROVAL);
      fs.writeFileSync(path.join(specDir, 'QA_FIX_REQUEST.md'), '# QA Fix Request: PR follow-up\n');

      await startTask();

      expect(agentManager.startQAProcess).toHaveBeenCalledTimes(1);
      expect(signoffNow()).toEqual(OLD_APPROVAL);
    });
  });

  it('uses launchTask when there is no fix request', async () => {
    pauseForAccount();
    writeSpec();
    writePlan(COMPLETE_PLAN);

    await startTask();

    expect(agentManager.startQAProcess).not.toHaveBeenCalled();
    expect(agentManager.startTaskExecution).toHaveBeenCalledTimes(1);
  });

  it("uses launchTask for a reviewer's leftover QA_FIX_REQUEST.md, so its fixer does not run again", async () => {
    pauseForAccount();
    writeSpec();
    writePlan(COMPLETE_PLAN);
    fs.writeFileSync(path.join(specDir, 'QA_FIX_REQUEST.md'), '# QA Fix Request\n\n**Status**: REJECTED\n\n### 1. Null check\n');

    await startTask();

    expect(agentManager.startQAProcess).not.toHaveBeenCalled();
    expect(agentManager.startTaskExecution).toHaveBeenCalledTimes(1);
  });

  it('uses launchTask when the build is not complete', async () => {
    pauseForAccount();
    writeSpec();
    writePlan(PLAN_WITH_SUBTASKS);
    fs.writeFileSync(path.join(specDir, 'QA_FIX_REQUEST.md'), REQUEST_CHANGES);

    await startTask();

    expect(agentManager.startQAProcess).not.toHaveBeenCalled();
    expect(agentManager.startTaskExecution).toHaveBeenCalledTimes(1);
  });

  it('uses launchTask when the task was not paused for an account', async () => {
    ref.task.status = 'human_review';
    ref.task.reviewReason = 'stopped';
    writeSpec();
    writePlan(COMPLETE_PLAN);
    fs.writeFileSync(path.join(specDir, 'QA_FIX_REQUEST.md'), REQUEST_CHANGES);

    await startTask();

    expect(agentManager.startQAProcess).not.toHaveBeenCalled();
    expect(agentManager.startTaskExecution).toHaveBeenCalledTimes(1);
  });
});

// zeenha fork: dragging an account-paused QA fix run to In Progress resumes it
// as the QA process too.
describe('applyTaskStatusUpdate -> in_progress resume of an account-paused QA fix run', () => {
  const REQUEST_CHANGES = '# QA Fix Request\n\nStatus: REJECTED\n\n## Feedback\n\nMake the button blue\n';

  beforeEach(() => {
    ref.task.status = 'human_review';
    ref.task.reviewReason = 'account_required';
    ref.task.metadata = { ...ref.task.metadata, phaseProviders: { qa: 'anthropic' } };
    writeSpec();
    writePlan({ phases: [{ subtasks: [{ id: 's1', status: 'completed' }] }] });
    fs.writeFileSync(path.join(specDir, 'QA_FIX_REQUEST.md'), REQUEST_CHANGES);
  });

  it('starts the QA process, not launchTask', async () => {
    expect(await updateStatus('in_progress')).toEqual({ success: true });
    expect(agentManager.startQAProcess).toHaveBeenCalledWith('t1', ref.project.path, '001-x', 'p1');
    expectNothingStarted();
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.TASK_STATUS_CHANGE, 't1', 'in_progress', 'p1');
  });

  it('starts QA without the manual status change, which would resume the machine before QA runs', async () => {
    await updateStatus('in_progress');
    expect(machine.handleManualStatusChange).not.toHaveBeenCalled();
    expect(machine.handleUiEvent.mock.calls.map((c) => c[1])).toEqual([{ type: 'USER_RESUMED' }]);
  });

  it('leaves the task paused and untouched, with no state event, when QA fails to start', async () => {
    agentManager.startQAProcess.mockRejectedValueOnce(new Error('spawn failed'));

    const res = await updateStatus('in_progress');

    expect(res.success).toBe(false);
    expect(machine.handleManualStatusChange).not.toHaveBeenCalled();
    expect(machine.handleUiEvent).not.toHaveBeenCalled();
    expect(errorsSent()).toHaveLength(1);
    expect(mainWindow.webContents.send).not.toHaveBeenCalledWith(IPC_CHANNELS.TASK_STATUS_CHANGE, 't1', 'in_progress', 'p1');
    expectNothingStarted();
  });

  it('uses launchTask when there is no fix request', async () => {
    fs.rmSync(path.join(specDir, 'QA_FIX_REQUEST.md'));
    await updateStatus('in_progress');
    expect(agentManager.startQAProcess).not.toHaveBeenCalled();
    expect(agentManager.startTaskExecution).toHaveBeenCalledTimes(1);
  });
});

describe('applyTaskStatusUpdate -> in_progress launch', () => {
  it('starts spec creation when there is no spec.md', async () => {
    expect(await updateStatus('in_progress')).toEqual({ success: true });
    expect(agentManager.startSpecCreation).toHaveBeenCalledWith(
      't1',
      ref.project.path,
      'Description',
      specDir,
      ref.task.metadata,
      'main',
      'p1'
    );
    expect(agentManager.startTaskExecution).not.toHaveBeenCalled();
    expect(watcher.watch).toHaveBeenCalledWith('t1', specDir);
  });

  it('starts task execution for a spec without a plan', async () => {
    writeSpec();
    await updateStatus('in_progress');
    expect(agentManager.startSpecCreation).not.toHaveBeenCalled();
    expect(agentManager.startTaskExecution).toHaveBeenCalledWith('t1', ref.project.path, '001-x', expectedOptions('main'), 'p1');
  });

  it('starts task execution for a spec with subtasks and prefers the task baseBranch', async () => {
    writeMetadata('feature/base');
    writeSpec();
    writePlan(PLAN_WITH_SUBTASKS);
    await updateStatus('in_progress');
    expect(agentManager.startTaskExecution).toHaveBeenCalledWith(
      't1',
      ref.project.path,
      '001-x',
      expectedOptions('feature/base'),
      'p1'
    );
  });

  it('sends TASK_STATUS_CHANGE after a start', async () => {
    await updateStatus('in_progress');
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.TASK_STATUS_CHANGE, 't1', 'in_progress', 'p1');
  });

  it('fails and reports when git is not usable', async () => {
    git.checkGitStatus.mockReturnValue({ isGitRepo: false, hasCommits: false, error: 'no git here' });
    const res = await updateStatus('in_progress');
    expect(res.success).toBe(false);
    expect(errorsSent()).toHaveLength(1);
    expectNothingStarted();
  });

  it('fails and reports when there is no authentication', async () => {
    auth.hasValidAuth.mockReturnValue(false);
    const res = await updateStatus('in_progress');
    expect(res.success).toBe(false);
    expect(errorsSent()).toHaveLength(1);
    expectNothingStarted();
  });

  it('lets a provider account bypass hasValidAuth() = false', async () => {
    auth.hasValidAuth.mockReturnValue(false);
    settings.value = { providerAccounts: [{ id: 'a1' }] };
    expect((await updateStatus('in_progress')).success).toBe(true);
    expect(agentManager.startSpecCreation).toHaveBeenCalledTimes(1);
  });
});

describe('TASK_RECOVER_STUCK auto-restart launch', () => {
  it('restarts a task that crashed in planning into task execution, never spec creation', async () => {
    writeSpec();
    writePlan({ phases: [{ subtasks: [] }] });
    const res = await recover();
    expect(res.success).toBe(true);
    expect(res.data?.autoRestarted).toBe(true);
    expect(agentManager.startSpecCreation).not.toHaveBeenCalled();
    expect(agentManager.startTaskExecution).toHaveBeenCalledWith('t1', ref.project.path, '001-x', expectedOptions('main'), 'p1');
    expect(watcher.watch).toHaveBeenCalledWith('t1', specDir);
  });

  it('starts spec creation with the main spec dir when there is no spec.md', async () => {
    const res = await recover();
    expect(res.data?.autoRestarted).toBe(true);
    expect(agentManager.startTaskExecution).not.toHaveBeenCalled();
    expect(agentManager.startSpecCreation).toHaveBeenCalledWith(
      't1',
      ref.project.path,
      'Description',
      specDir,
      ref.task.metadata,
      'main',
      'p1'
    );
  });

  it('recovers without restarting when auth is missing', async () => {
    writeSpec();
    auth.hasValidAuth.mockReturnValue(false);
    const res = await recover();
    expect(res.success).toBe(true);
    expect(res.data?.autoRestarted).toBe(false);
    expectNothingStarted();
  });

  it('recovers without restarting when git is missing', async () => {
    writeSpec();
    git.checkGitStatus.mockReturnValue({ isGitRepo: false, hasCommits: false, error: 'no git' });
    const res = await recover();
    expect(res.success).toBe(true);
    expect(res.data?.autoRestarted).toBe(false);
    expectNothingStarted();
  });
});
