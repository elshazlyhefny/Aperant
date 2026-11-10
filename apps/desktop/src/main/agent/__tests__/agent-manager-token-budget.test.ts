/**
 * zeenha fork: the token budget serialized into the worker session config comes
 * from task metadata (0 = unlimited) else the project settings.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp'), getAppPath: vi.fn(() => '/tmp'), isPackaged: false, getVersion: vi.fn(() => '0.0.0') },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: vi.fn(),
}));

import { AgentManager } from '../agent-manager';

describe('AgentManager.resolveTaskTokenBudget', () => {
  let dir: string;
  const resolve = (settings?: { tokenBudget?: number }) =>
    AgentManager.prototype.resolveTaskTokenBudget.call({}, dir, settings);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'token-budget-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('has no budget without metadata or project setting', () => {
    expect(resolve()).toBeUndefined();
  });

  it('carries the budget from task metadata', () => {
    writeFileSync(join(dir, 'task_metadata.json'), JSON.stringify({ tokenBudget: 500000 }));
    expect(resolve({ tokenBudget: 100 })).toBe(500000);
  });

  it('falls back to the project setting', () => {
    writeFileSync(join(dir, 'task_metadata.json'), JSON.stringify({ model: 'sonnet' }));
    expect(resolve({ tokenBudget: 2000000 })).toBe(2000000);
  });

  it('treats a task value of 0 as unlimited even with a project budget', () => {
    writeFileSync(join(dir, 'task_metadata.json'), JSON.stringify({ tokenBudget: 0 }));
    expect(resolve({ tokenBudget: 2000000 })).toBeUndefined();
  });

  it('ignores corrupt metadata', () => {
    writeFileSync(join(dir, 'task_metadata.json'), '{nope');
    expect(resolve({ tokenBudget: 7 })).toBe(7);
  });
});
