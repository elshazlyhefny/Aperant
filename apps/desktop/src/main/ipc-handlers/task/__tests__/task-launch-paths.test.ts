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

vi.mock('../../../worktree-paths', () => ({ findTaskWorktree: () => null }));
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

const agentManager = {
  isRunning: vi.fn(() => false),
  killTask: vi.fn(),
  startSpecCreation: vi.fn(),
  startTaskExecution: vi.fn(),
};
const mainWindow = { webContents: { send: vi.fn() } };

let specDir = '';

function writeSpec() {
  fs.writeFileSync(path.join(specDir, 'spec.md'), `# Spec\n\n${'A real specification line. '.repeat(10)}\n`);
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
    ref.task.metadata.baseBranch = 'feature/base';
    writeSpec();
    await startTask();
    expect(agentManager.startTaskExecution.mock.calls[0][3]).toEqual(expectedOptions('feature/base'));
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
    ref.task.metadata.baseBranch = 'feature/base';
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
