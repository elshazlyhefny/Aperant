/**
 * zeenha fork: removing a task's worktree after its PR merged.
 *
 * Each check is proven to block removal on its own: every "kept" case below
 * starts from the fixture that IS removed and changes exactly one fact.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../cli-tool-manager', () => ({ getToolPath: (tool: string) => tool }));
vi.mock('../env-utils', () => ({ getAugmentedEnv: () => ({ ...process.env }) }));

import type { Project, Task } from '../../shared/types';
import { cleanupMergedWorktrees, type MergedCleanupDeps, type PullRequestState } from '../worktree-auto-cleanup';

const HEAD = 'a'.repeat(40);
const PR = 'https://github.com/o/r/pull/7';

interface Fixture {
  prUrl?: string;
  worktree?: string | null;
  pr?: PullRequestState | null;
  running?: boolean[]; // answers to successive isRunning calls
  real?: boolean;
  dirty?: boolean;
  head?: string | null;
  branch?: string | null;
  inPr?: boolean | null;
  deletable?: { ok: boolean; detail?: string };
  removeOk?: boolean;
  settings?: Project['settings'];
}

function setup(f: Fixture = {}) {
  const project = { id: 'p1', path: '/repo', settings: f.settings ?? {} } as unknown as Project;
  const task = { id: 't1', specId: '016-keep-focus', metadata: { prUrl: 'prUrl' in f ? f.prUrl : PR } } as unknown as Task;
  const running = [...(f.running ?? [false, false])];
  const deps: MergedCleanupDeps = {
    listProjects: () => [project],
    listTasks: () => [task],
    findWorktree: () => ('worktree' in f ? (f.worktree ?? null) : '/repo/.auto-claude/worktrees/tasks/016-keep-focus'),
    isRunning: vi.fn(() => running.shift() ?? false),
    prState: vi.fn(async () => ('pr' in f ? (f.pr ?? null) : { state: 'MERGED', headRefOid: HEAD })),
    isRealWorktree: vi.fn(async () => f.real ?? true),
    hasUncommittedChanges: vi.fn(async () => f.dirty ?? false),
    headCommit: vi.fn(async () => ('head' in f ? (f.head ?? null) : HEAD)),
    branchTip: vi.fn(async () => ('branch' in f ? (f.branch ?? null) : HEAD)),
    isInPullRequest: vi.fn(async () => ('inPr' in f ? (f.inPr ?? null) : true)),
    ensureDeletable: vi.fn(async () => f.deletable ?? { ok: true }),
    deleteBranch: vi.fn(async () => ({ success: true })),
    remove: vi.fn(async () => ({ success: f.removeOk ?? true, warnings: f.removeOk === false ? ['locked'] : [] })),
    invalidate: vi.fn(),
  };
  return { deps, run: () => cleanupMergedWorktrees(deps) };
}

describe('cleanupMergedWorktrees', () => {
  it('removes the worktree when the PR merged, nothing is running, it is clean and HEAD is the merged head', async () => {
    const { deps, run } = setup();
    const outcomes = await run();
    expect(outcomes).toEqual([
      { projectId: 'p1', taskId: 't1', specId: '016-keep-focus', prUrl: PR, status: 'removed' },
    ]);
    expect(deps.remove).toHaveBeenCalledWith({
      worktreePath: '/repo/.auto-claude/worktrees/tasks/016-keep-focus',
      projectPath: '/repo',
      specId: '016-keep-focus',
    });
    expect(deps.invalidate).toHaveBeenCalledWith('p1');
  });

  it.each([
    ['OPEN', 'not_merged'],
    ['CLOSED', 'not_merged'],
  ])('leaves a %s PR alone', async (state, status) => {
    const { deps, run } = setup({ pr: { state, headRefOid: HEAD } });
    expect((await run())[0].status).toBe(status);
    expect(deps.remove).not.toHaveBeenCalled();
  });

  it.each<[string, Fixture, string]>([
    ['the PR cannot be read', { pr: null }, 'pr_unreadable'],
    ['an agent is running', { running: [true] }, 'running'],
    ['an agent started during the checks', { running: [false, true] }, 'running'],
    ['there are uncommitted changes', { dirty: true }, 'uncommitted_changes'],
    ['HEAD has commits the PR does not', { inPr: false }, 'commits_after_merge'],
    ['the PR head cannot be compared', { inPr: null }, 'pr_unreadable'],
    ['files are owned by another user and cannot be handed back', { deletable: { ok: false, detail: 'vendor' } }, 'foreign_owned_files'],
    ['a leftover folder whose branch has unmerged commits', { real: false, inPr: false }, 'commits_after_merge'],
    ['HEAD cannot be read', { head: null }, 'head_unreadable'],
    ['the removal itself fails', { removeOk: false }, 'cleanup_failed'],
  ])('keeps the worktree when %s', async (_name, fixture, reason) => {
    const { deps, run } = setup(fixture);
    const [outcome] = await run();
    expect(outcome).toMatchObject({ status: 'kept', reason });
    if (reason !== 'cleanup_failed') expect(deps.remove).not.toHaveBeenCalled();
    expect(deps.invalidate).not.toHaveBeenCalled();
  });

  it('removes a worktree that is BEHIND its PR head (commits were added on GitHub)', async () => {
    const { deps, run } = setup({ head: 'c'.repeat(40), inPr: true });
    expect((await run())[0].status).toBe('removed');
    expect(deps.isInPullRequest).toHaveBeenCalledWith('/repo', 'c'.repeat(40), PR, HEAD);
  });

  it('checks a leftover folder (no .git) through its branch, never through git inside it', async () => {
    const { deps, run } = setup({ real: false, branch: 'd'.repeat(40) });
    expect((await run())[0].status).toBe('removed');
    expect(deps.hasUncommittedChanges).not.toHaveBeenCalled();
    expect(deps.headCommit).not.toHaveBeenCalled();
    expect(deps.branchTip).toHaveBeenCalledWith('/repo', 'auto-claude/016-keep-focus');
    expect(deps.isInPullRequest).toHaveBeenCalledWith('/repo', 'd'.repeat(40), PR, HEAD);
  });

  it('removes a leftover folder whose branch is already gone', async () => {
    const { deps, run } = setup({ real: false, branch: null });
    expect((await run())[0].status).toBe('removed');
    expect(deps.isInPullRequest).not.toHaveBeenCalled();
  });

  it('makes the folder deletable before deleting, and deletes nothing when it cannot', async () => {
    const order: string[] = [];
    const { deps, run } = setup({ deletable: { ok: false, detail: 'vendor/autoload.php' } });
    deps.ensureDeletable = vi.fn(async () => {
      order.push('ensure');
      return { ok: false, detail: 'vendor/autoload.php' };
    });
    expect((await run())[0]).toMatchObject({ status: 'kept', reason: 'foreign_owned_files', detail: 'vendor/autoload.php' });
    expect(order).toEqual(['ensure']);
    expect(deps.remove).not.toHaveBeenCalled();
  });

  it('deletes the left-behind branch when the folder is already gone and the branch is merged', async () => {
    const { deps, run } = setup({ worktree: null });
    expect((await run())[0].status).toBe('removed');
    expect(deps.deleteBranch).toHaveBeenCalledWith('/repo', 'auto-claude/016-keep-focus');
    expect(deps.remove).not.toHaveBeenCalled();
  });

  it('keeps a left-behind branch with commits the PR does not have', async () => {
    const { deps, run } = setup({ worktree: null, inPr: false });
    expect((await run())[0]).toMatchObject({ status: 'kept', reason: 'commits_after_merge' });
    expect(deps.deleteBranch).not.toHaveBeenCalled();
  });

  it('leaves a left-behind branch alone while its PR is open', async () => {
    const { deps, run } = setup({ worktree: null, pr: { state: 'OPEN', headRefOid: HEAD } });
    expect(await run()).toEqual([]);
    expect(deps.deleteBranch).not.toHaveBeenCalled();
  });

  it('never asks GitHub about a task with no PR, or with neither a worktree nor a branch', async () => {
    for (const f of [{ prUrl: undefined }, { worktree: null, branch: null }] as Fixture[]) {
      const { deps, run } = setup(f);
      expect(await run()).toEqual([]);
      expect(deps.prState).not.toHaveBeenCalled();
    }
  });

  it('does nothing in a project that turned the setting off', async () => {
    const { deps, run } = setup({ settings: { autoCleanupMergedWorktrees: false } as Project['settings'] });
    expect(await run()).toEqual([]);
    expect(deps.prState).not.toHaveBeenCalled();
  });

  it('only touches the requested project', async () => {
    const { deps } = setup();
    expect(await cleanupMergedWorktrees(deps, { projectId: 'other' })).toEqual([]);
    expect(deps.remove).not.toHaveBeenCalled();
  });

  it('turns an unexpected error into a kept outcome instead of throwing', async () => {
    const { deps } = setup();
    deps.hasUncommittedChanges = vi.fn(async () => {
      throw new Error('boom');
    });
    expect(await cleanupMergedWorktrees(deps)).toEqual([
      expect.objectContaining({ status: 'kept', reason: 'cleanup_failed', detail: 'boom' }),
    ]);
  });
});
