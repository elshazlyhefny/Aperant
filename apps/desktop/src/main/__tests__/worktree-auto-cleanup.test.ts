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
  dirty?: boolean;
  head?: string | null;
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
    hasUncommittedChanges: vi.fn(async () => f.dirty ?? false),
    headCommit: vi.fn(async () => ('head' in f ? (f.head ?? null) : HEAD)),
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
    ['HEAD moved past the merged commit', { head: 'b'.repeat(40) }, 'commits_after_merge'],
    ['HEAD cannot be read', { head: null }, 'head_unreadable'],
    ['the removal itself fails', { removeOk: false }, 'cleanup_failed'],
  ])('keeps the worktree when %s', async (_name, fixture, reason) => {
    const { deps, run } = setup(fixture);
    const [outcome] = await run();
    expect(outcome).toMatchObject({ status: 'kept', reason });
    if (reason !== 'cleanup_failed') expect(deps.remove).not.toHaveBeenCalled();
    expect(deps.invalidate).not.toHaveBeenCalled();
  });

  it('never asks GitHub about a task with no PR or no worktree', async () => {
    for (const f of [{ prUrl: undefined }, { worktree: null }] as Fixture[]) {
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
