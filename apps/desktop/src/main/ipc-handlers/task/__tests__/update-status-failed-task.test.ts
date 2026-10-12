/**
 * zeenha fork: TASK_UPDATE_STATUS refuses to put a Failed task (status
 * `error`) up for AI Review or Human Review: it did no work, so there is
 * nothing to review. The drag handler refuses too, but the server is the
 * control. The refusal must change nothing (no state-machine event, no plan
 * write), and the allowed moves out of Failed, and review moves for a task
 * that did not fail, must still go through.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../../shared/constants';
import type { TaskStatus } from '../../../../shared/types';
// Imported statically (vi.mock calls below are hoisted above it): a cold
// import of the handler graph inside a test counts against the test timeout.
import { registerTaskExecutionHandlers } from '../execution-handlers';

const handlers = vi.hoisted(() => new Map<string, Function>());
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: Function) => handlers.set(ch, fn), on: vi.fn() },
  BrowserWindow: class {},
  shell: { openPath: vi.fn() },
  app: { getPath: () => os.tmpdir(), isPackaged: false, on: vi.fn() },
}));

const ref = vi.hoisted(() => ({ status: 'error' as string, projectPath: '' }));
vi.mock('../shared', () => ({
  findTaskAndProject: () => ({
    task: { id: 't1', specId: '001-x', status: ref.status, title: 'T', metadata: {} },
    project: { id: 'p1', path: ref.projectPath, autoBuildPath: '.auto-claude', settings: {} },
  }),
}));

const machine = vi.hoisted(() => ({
  handleManualStatusChange: vi.fn(() => true),
  handleUiEvent: vi.fn(),
  prepareForRestart: vi.fn(),
}));
vi.mock('../../../task-state-manager', () => ({ taskStateManager: machine }));

const plan = vi.hoisted(() => ({
  persistPlanStatus: vi.fn(async () => true),
  createPlanIfNotExists: vi.fn(async () => undefined),
}));
vi.mock('../plan-file-utils', () => ({
  getPlanPath: () => '/nonexistent/implementation_plan.json',
  persistPlanStatus: plan.persistPlanStatus,
  createPlanIfNotExists: plan.createPlanIfNotExists,
  resetStuckSubtasks: vi.fn(async () => ({ success: true, resetCount: 0 })),
  hasPlanWithSubtasks: vi.fn(() => false),
}));

vi.mock('../../../worktree-paths', () => ({ findTaskWorktree: () => null }));
vi.mock('../../../project-store', () => ({ projectStore: { invalidateTasksCache: vi.fn() } }));
// In Progress auto-starts the task; stop that at the first check, after the
// status change itself has gone through.
vi.mock('../../../project-initializer', () => ({
  checkGitStatus: () => ({ isGitRepo: false, hasCommits: false, error: 'no git here' }),
}));

const REFUSAL =
  'A failed task cannot be moved to review: it has no work to review. Retry it, re-plan it, or move it to Backlog.';

const agentManager = { isRunning: vi.fn(() => false), killTask: vi.fn() };

async function updateStatus(status: TaskStatus) {
  // biome-ignore lint/suspicious/noExplicitAny: a minimal AgentManager stand-in
  registerTaskExecutionHandlers(agentManager as any, () => null);
  const fn = handlers.get(IPC_CHANNELS.TASK_UPDATE_STATUS);
  if (!fn) throw new Error('TASK_UPDATE_STATUS handler was not registered');
  return fn({}, 't1', status) as Promise<{ success: boolean; error?: string }>;
}

beforeEach(() => {
  handlers.clear();
  machine.handleManualStatusChange.mockClear();
  machine.handleUiEvent.mockClear();
  plan.persistPlanStatus.mockClear();
  plan.createPlanIfNotExists.mockClear();
  ref.projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'update-status-failed-'));
  // A real spec, so Human Review's own "no spec yet" guard is not what decides.
  const specDir = path.join(ref.projectPath, '.auto-claude', 'specs', '001-x');
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(path.join(specDir, 'spec.md'), `# Spec\n\n${'A real specification line. '.repeat(10)}\n`);
});

describe('TASK_UPDATE_STATUS for a Failed task (zeenha fork)', () => {
  it.each(['ai_review', 'human_review'] as const)(
    'refuses %s and changes nothing',
    async (target) => {
      ref.status = 'error';
      expect(await updateStatus(target)).toEqual({ success: false, error: REFUSAL });
      expect(machine.handleManualStatusChange).not.toHaveBeenCalled();
      expect(machine.handleUiEvent).not.toHaveBeenCalled();
      expect(plan.persistPlanStatus).not.toHaveBeenCalled();
      expect(plan.createPlanIfNotExists).not.toHaveBeenCalled();
    }
  );

  it.each(['backlog', 'queue', 'in_progress', 'done'] as const)(
    'lets %s through to the state machine',
    async (target) => {
      ref.status = 'error';
      const res = await updateStatus(target);
      expect(res.error).not.toBe(REFUSAL);
      expect(machine.handleManualStatusChange).toHaveBeenCalledWith('t1', target, expect.anything(), expect.anything());
    }
  );

  it('keeps an `error` -> `error` update a no-op rather than a refusal', async () => {
    ref.status = 'error';
    const res = await updateStatus('error');
    expect(res.error).not.toBe(REFUSAL);
  });
});

describe('TASK_UPDATE_STATUS for a task that did not fail', () => {
  it.each(['ai_review', 'human_review'] as const)(
    'still lets an in-progress task move to %s',
    async (target) => {
      ref.status = 'in_progress';
      expect(await updateStatus(target)).toEqual({ success: true });
      expect(machine.handleManualStatusChange).toHaveBeenCalledWith('t1', target, expect.anything(), expect.anything());
    }
  );
});
