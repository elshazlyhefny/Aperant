/**
 * zeenha fork: one merged-cleanup run at a time, but a request is only answered
 * by a running run that covers it, and only with its own project's outcomes.
 * It used to hand back whatever run was in flight.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../cli-tool-manager', () => ({ getToolPath: (tool: string) => tool }));
vi.mock('../env-utils', () => ({ getAugmentedEnv: () => ({ ...process.env }) }));

import type { Project, Task } from '../../shared/types';
import { type MergedCleanupDeps, runMergedWorktreeCleanup } from '../worktree-auto-cleanup';

function deps(gate: Promise<void>): MergedCleanupDeps {
  const projects = ['pA', 'pB'].map((id) => ({ id, path: `/${id}`, settings: {} }) as unknown as Project);
  return {
    listProjects: () => projects,
    listTasks: (projectId) =>
      [{ id: `${projectId}-t`, specId: `001-${projectId}`, metadata: { prUrl: `https://github.com/o/r/pull/${projectId === 'pA' ? 1 : 2}` } }] as unknown as Task[],
    findWorktree: () => '/wt',
    isRunning: () => false,
    prState: async () => {
      await gate;
      return { state: 'OPEN', headRefOid: 'a'.repeat(40) };
    },
    isRealWorktree: async () => true,
    hasUncommittedChanges: async () => false,
    headCommit: async () => 'a'.repeat(40),
    branchTip: async () => null,
    isInPullRequest: async () => true,
    ensureDeletable: async () => ({ ok: true }),
    deleteBranch: async () => ({ success: true }),
    remove: async () => ({ success: true, warnings: [] }),
    invalidate: () => undefined,
  };
}

describe('runMergedWorktreeCleanup while another run is in flight', () => {
  it("answers a project's request from an all-projects run with only that project's outcomes", async () => {
    let open!: () => void;
    const d = deps(new Promise<void>((r) => { open = r; }));
    const all = runMergedWorktreeCleanup(d);
    const forA = runMergedWorktreeCleanup(d, { projectId: 'pA' });
    open();
    expect((await all).map((o) => o.projectId).sort()).toEqual(['pA', 'pB']);
    expect((await forA).map((o) => o.projectId)).toEqual(['pA']);
  });

  it('runs a different project after the running one instead of returning its results', async () => {
    let open!: () => void;
    const d = deps(new Promise<void>((r) => { open = r; }));
    const forA = runMergedWorktreeCleanup(d, { projectId: 'pA' });
    const forB = runMergedWorktreeCleanup(d, { projectId: 'pB' });
    open();
    expect((await forA).map((o) => o.projectId)).toEqual(['pA']);
    expect((await forB).map((o) => o.projectId)).toEqual(['pB']);
  });
});
