import { describe, it, expect, vi } from 'vitest';
import { dispatchIssueOutcomeWith, normalizeIssueWritebackSettings } from '../issue-writeback-core';
import type { OutcomeWriter } from '../../forge/types';
import { buildOutcomeComment } from '../common';

const project = { path: '/p' } as never;

function makeWriter(sourceType: string, settingKey: string, impl?: () => Promise<void>) {
  return { sourceType, settingKey, postOutcome: vi.fn(impl ?? (async () => undefined)) } as never as OutcomeWriter & {
    postOutcome: ReturnType<typeof vi.fn>;
  };
}

describe('dispatchIssueOutcomeWith', () => {
  const meta = { sourceType: 'alpha' };

  it('awaits the matching writer with the built text', async () => {
    let done = false;
    const w = makeWriter('alpha', 'github', async () => {
      await new Promise((r) => setTimeout(r, 10));
      done = true;
    });
    await dispatchIssueOutcomeWith({
      title: 'T', prUrl: 'https://x.io/pr/1', project, event: 'review_ready', meta,
      settings: { github: true, gitlab: false, linear: false } as never, writers: [w]
    });
    expect(done).toBe(true);
    expect(w.postOutcome).toHaveBeenCalledWith({
      meta, project, event: 'review_ready', text: buildOutcomeComment('review_ready', 'T', 'https://x.io/pr/1')
    });
  });

  it('skips pr_opened, null meta, disabled settings and unknown sources', async () => {
    const w = makeWriter('alpha', 'github');
    const on = { github: true, gitlab: false, linear: false } as never;
    const off = { github: false, gitlab: false, linear: false } as never;
    await dispatchIssueOutcomeWith({ project, event: 'pr_opened', meta, settings: on, writers: [w] });
    await dispatchIssueOutcomeWith({ project, event: 'failed', meta: null, settings: on, writers: [w] });
    await dispatchIssueOutcomeWith({ project, event: 'failed', meta, settings: off, writers: [w] });
    await dispatchIssueOutcomeWith({ project, event: 'failed', meta: { sourceType: 'zzz' }, settings: on, writers: [w] });
    expect(w.postOutcome).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    const w = makeWriter('alpha', 'github', async () => {
      throw new Error('boom');
    });
    await expect(
      dispatchIssueOutcomeWith({
        project, event: 'failed', meta, settings: { github: true } as never, writers: [w]
      })
    ).resolves.toBeUndefined();
  });
});

describe('normalizeIssueWritebackSettings', () => {
  it('defaults to off and only accepts true for known writers', () => {
    const w = makeWriter('alpha', 'github');
    expect(normalizeIssueWritebackSettings(undefined, [w]).github).toBe(false);
    expect(normalizeIssueWritebackSettings({ issueWriteback: { github: 'yes' } }, [w]).github).toBe(false);
    expect(normalizeIssueWritebackSettings({ issueWriteback: { github: true } }, [w]).github).toBe(true);
  });
});
