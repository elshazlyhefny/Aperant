/**
 * zeenha fork: the accounts a proactive swap moved a routed task away from apply
 * only across that swap's restart. A refused restart, a stop or a new user start
 * forgets them, so a later Start can use the swapped-away account again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp'), getAppPath: vi.fn(() => '/tmp'), isPackaged: false, getVersion: vi.fn(() => '0.0.0') },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: vi.fn(),
}));

const settings = vi.hoisted(() => ({ value: undefined as Record<string, unknown> | undefined }));
vi.mock('../../settings-utils', async importOriginal => ({
  ...(await importOriginal<object>()),
  readSettingsFile: () => settings.value,
}));

import { AgentManager } from '../agent-manager';
import { getOperationRegistry } from '../../claude-profile/operation-registry';

interface Internals {
  swappedAccounts: Map<string, { accountIds: Set<string>; profileId: string }>;
  restartAfterSwap(taskId: string, accountIds: string[], newProfileId: string): boolean;
  restartRunningTask(taskId: string, newProfileId: string): boolean;
  state: { addProcess(taskId: string, process: object): void };
  storeTaskContext(taskId: string, projectPath: string, specId: string, options: object): void;
  taskPhaseResolver(): undefined;
  readyForLegacyTask(): Promise<boolean>;
}

describe('AgentManager swapped accounts', () => {
  let manager: AgentManager;
  let internals: Internals;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new AgentManager();
    internals = manager as unknown as Internals;
    // Let startTaskExecution return right after its bookkeeping.
    internals.taskPhaseResolver = () => undefined;
    internals.readyForLegacyTask = async () => false;
  });
  afterEach(() => {
    getOperationRegistry().unregisterOperation('t');
    vi.useRealTimers();
  });

  /** A task whose worker is still being set up counts as running. */
  const markRunning = (taskId: string) =>
    internals.state.addProcess(taskId, { taskId, process: null, startedAt: new Date(), spawnId: 1 });

  it('records nothing when the restart is refused', () => {
    expect(internals.restartAfterSwap('t', ['a'], 'profile-b')).toBe(false);
    expect(internals.swappedAccounts.has('t')).toBe(false);
  });

  it('keeps the swap across its restart and drops it on the next user start', async () => {
    internals.storeTaskContext('t', '/project', '001-x', {});
    markRunning('t');
    const start = vi.spyOn(manager, 'startTaskExecution');
    expect(internals.restartAfterSwap('t', ['a'], 'profile-b')).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(start).toHaveBeenCalledOnce();
    expect(internals.swappedAccounts.get('t')).toEqual({ accountIds: new Set(['a']), profileId: 'profile-b' });

    await manager.startTaskExecution('t', '/project', '001-x');
    expect(internals.swappedAccounts.has('t')).toBe(false);
  });

  it('never excludes the account the swap chose, even one the task left earlier', async () => {
    settings.value = { providerAccounts: [
      { id: 'a', provider: 'anthropic', claudeProfileId: 'profile-a' },
      { id: 'b', provider: 'anthropic', claudeProfileId: 'profile-b' },
    ] };
    internals.storeTaskContext('t', '/project', '001-x', {});
    markRunning('t');
    // A → B earlier, now B → A: A must not stay excluded.
    expect(internals.restartAfterSwap('t', ['a', 'b'], 'profile-a')).toBe(true);
    expect(internals.swappedAccounts.get('t')).toEqual({ accountIds: new Set(['b']), profileId: 'profile-a' });
    settings.value = undefined;
    await vi.advanceTimersByTimeAsync(600);
  });

  it('drops the swap when the task is stopped', () => {
    internals.swappedAccounts.set('t', { accountIds: new Set(['a']), profileId: 'profile-b' });
    manager.killTask('t');
    expect(internals.swappedAccounts.has('t')).toBe(false);
  });

  it.each([
    ['routed', (id: string) => internals.restartAfterSwap(id, ['a'], 'profile-b')],
    ['legacy', (id: string) => internals.restartRunningTask(id, 'profile-b')],
  ])('does not restart a stopped %s task on a proactive swap', async (_kind, restartFn) => {
    internals.storeTaskContext('t', '/project', '001-x', {});
    markRunning('t');
    const registry = getOperationRegistry();
    registry.registerOperation('t', 'task-execution', 'profile-a', 'A', restartFn);
    const start = vi.spyOn(manager, 'startTaskExecution');

    manager.killTask('t');
    expect(registry.getOperation('t')).toBeUndefined();
    expect(await registry.restartOperationsOnProfile('profile-a', 'profile-b', 'B')).toBe(0);
    // Even a registration that outlived the process restarts nothing.
    expect(restartFn('t')).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    expect(start).not.toHaveBeenCalled();
  });

  it('does not restart a task that exited on a proactive swap', async () => {
    internals.storeTaskContext('t', '/project', '001-x', {});
    const start = vi.spyOn(manager, 'startTaskExecution');
    expect(internals.restartRunningTask('t', 'profile-b')).toBe(false);
    expect(internals.restartAfterSwap('t', ['a'], 'profile-b')).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    expect(start).not.toHaveBeenCalled();
  });

  it('drops a pending swap restart when the user stops the task', async () => {
    internals.storeTaskContext('t', '/project', '001-x', {});
    markRunning('t');
    const start = vi.spyOn(manager, 'startTaskExecution');
    expect(internals.restartRunningTask('t', 'profile-b')).toBe(true);
    manager.killTask('t');
    await vi.advanceTimersByTimeAsync(600);
    expect(start).not.toHaveBeenCalled();
  });
});
