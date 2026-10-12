/**
 * zeenha fork: merging a task worktree locally would put work on the base
 * branch without the repository's CI and merge queue. While PR-only landing is
 * on (the default) the handler refuses BEFORE it touches git. The positive
 * control shows the refusal, not some other failure, is what stops it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../../shared/constants';
import { PR_ONLY_LANDING_MESSAGE } from '../../../../shared/utils/landing-policy';
// Imported statically, not inside a test: this module's graph is large, and a
// cold import inside the first test counted against its 5s timeout, which a
// loaded full-suite run exceeded ("Test timed out in 5000ms"). vi.mock calls
// below are hoisted above this import, so the mocks still apply.
import { registerWorktreeHandlers } from '../worktree-handlers';

const handlers = vi.hoisted(() => new Map<string, Function>());
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: Function) => handlers.set(ch, fn), on: vi.fn() },
  BrowserWindow: class {},
  shell: { openPath: vi.fn() },
  app: { getPath: () => os.tmpdir(), isPackaged: false, on: vi.fn() },
}));

const ref = vi.hoisted(() => ({ settings: {} as Record<string, unknown>, path: '' }));
vi.mock('../shared', () => ({
  findTaskAndProject: () => ({
    task: { id: 't1', specId: '001-x' },
    project: { id: 'p1', path: ref.path, autoBuildPath: '.auto-claude', settings: ref.settings },
  }),
}));

describe('TASK_WORKTREE_MERGE and PR-only landing (zeenha fork)', () => {
  beforeEach(() => {
    handlers.clear();
    ref.path = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-pr-only-'));
  });

  const merge = async (options: { noCommit?: boolean } = {}) => {
    registerWorktreeHandlers(() => null);
    const fn = handlers.get(IPC_CHANNELS.TASK_WORKTREE_MERGE);
    if (!fn) throw new Error('TASK_WORKTREE_MERGE handler was not registered');
    return fn({}, 't1', options) as Promise<{ success: boolean; error?: string }>;
  };

  it('refuses by default with the PR-only message', async () => {
    ref.settings = {};
    expect(await merge()).toEqual({ success: false, error: PR_ONLY_LANDING_MESSAGE });
  });

  it('refuses with the stage-only option too', async () => {
    ref.settings = {};
    const res = await merge({ noCommit: true });
    expect(res).toEqual({ success: false, error: PR_ONLY_LANDING_MESSAGE });
  });

  it('gets past the guard when the project turned it off', async () => {
    ref.settings = { prOnlyLanding: false };
    const res = await merge();
    // There is no real worktree here, so the merge fails for its own reason;
    // what matters is that it is NOT the PR-only refusal.
    expect(res.error).not.toBe(PR_ONLY_LANDING_MESSAGE);
  });
});
