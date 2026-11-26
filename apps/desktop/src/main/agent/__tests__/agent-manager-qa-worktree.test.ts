import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getAppPath: () => tmpdir(), isPackaged: false, getVersion: () => '0.0.0' },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: vi.fn(),
}));

import { projectStore } from '../../project-store';
import { AgentManager } from '../agent-manager';
import { getTaskWorktreePath } from '../../worktree-paths';

it('starts QA from a linked task worktree with PR-only landing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aperant-qa-'));
  try {
    const specId = '001-fix';
    const tree = getTaskWorktreePath(root, specId);
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
    git('init');
    git('-c', 'user.name=Tester', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial');
    git('worktree', 'add', '--detach', tree);
    const specDir = join(tree, '.auto-claude', 'specs', specId);
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, 'task_metadata.json'), JSON.stringify({ phaseProviders: { qa: 'openai' } }));
    vi.spyOn(projectStore, 'getProjects').mockReturnValue([
      { id: 'p1', path: root, settings: { prOnlyLanding: true } } as ReturnType<typeof projectStore.getProjects>[number],
    ]);
    const manager = new AgentManager();
    const spawn = vi.spyOn(manager['processManager'], 'spawnWorkerProcess').mockResolvedValue(undefined);
    await manager.startQAProcess('task', tree, specId, 'p1');
    expect(spawn).toHaveBeenCalledWith('task', expect.objectContaining({
      session: expect.objectContaining({ projectDir: tree, specDir }),
    }), {}, 'qa-process', 'p1');
  } finally {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});
