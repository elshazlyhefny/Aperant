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

import { AgentManager } from '../agent-manager';

interface Internals {
  swappedAccounts: Map<string, { accountIds: Set<string>; profileId: string }>;
  restartAfterSwap(taskId: string, accountIds: string[], newProfileId: string): boolean;
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
    vi.useRealTimers();
  });

  it('records nothing when the restart is refused', () => {
    expect(internals.restartAfterSwap('t', ['a'], 'profile-b')).toBe(false);
    expect(internals.swappedAccounts.has('t')).toBe(false);
  });

  it('keeps the swap across its restart and drops it on the next user start', async () => {
    internals.storeTaskContext('t', '/project', '001-x', {});
    const start = vi.spyOn(manager, 'startTaskExecution');
    expect(internals.restartAfterSwap('t', ['a'], 'profile-b')).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(start).toHaveBeenCalledOnce();
    expect(internals.swappedAccounts.get('t')).toEqual({ accountIds: new Set(['a']), profileId: 'profile-b' });

    await manager.startTaskExecution('t', '/project', '001-x');
    expect(internals.swappedAccounts.has('t')).toBe(false);
  });

  it('drops the swap when the task is stopped', () => {
    internals.swappedAccounts.set('t', { accountIds: new Set(['a']), profileId: 'profile-b' });
    manager.killTask('t');
    expect(internals.swappedAccounts.has('t')).toBe(false);
  });
});
