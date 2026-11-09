import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false, on: vi.fn() } }));

import { decideMergeOutcome } from '../worktree-merge';

describe('decideMergeOutcome', () => {
  it('full merge completes the task and cleans up the worktree', () => {
    const o = decideMergeOutcome({ isStageOnly: false, hasActualStagedChanges: false, mergeAlreadyCommitted: false });
    expect(o).toMatchObject({ newStatus: 'done', planStatus: 'completed', staged: false, cleanupWorktree: true });
    expect(o.reviewReason).toBeUndefined();
  });

  it('stage-only with staged changes reports staged', () => {
    const o = decideMergeOutcome({ isStageOnly: true, hasActualStagedChanges: true, mergeAlreadyCommitted: false });
    expect(o).toMatchObject({ newStatus: 'human_review', planStatus: 'review', staged: true, reviewReason: 'completed', cleanupWorktree: false });
    expect(o.message).toContain('Changes staged');
  });

  it('stage-only with nothing staged keeps review without staging', () => {
    const o = decideMergeOutcome({ isStageOnly: true, hasActualStagedChanges: false, mergeAlreadyCommitted: false });
    expect(o).toMatchObject({ newStatus: 'human_review', staged: false, cleanupWorktree: false });
    expect(o.message).toContain('No changes to stage');
  });

  it('stage-only already committed keeps review and does not clean up', () => {
    const o = decideMergeOutcome({ isStageOnly: true, hasActualStagedChanges: false, mergeAlreadyCommitted: true });
    expect(o).toMatchObject({ newStatus: 'human_review', staged: false, cleanupWorktree: false });
    expect(o.message).toContain('already merged');
  });
});
