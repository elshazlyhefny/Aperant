import { describe, it, expect, vi } from 'vitest';
import { anyWriterEnabled, dispatchIssueOutcomeWith } from '../issue-writeback-core';
import type { OutcomeWriter } from '../../forge/types';
import { buildOutcomeComment } from '../common';
import { normalizeIssueWritebackSettings } from '../../../../shared/utils/issue-writeback-settings';

const project = { path: '/p' } as never;

function makeWriter(sourceType: string, extra: Partial<OutcomeWriter>, impl?: () => Promise<void>) {
  return { sourceType, ...extra, postOutcome: vi.fn(impl ?? (async () => undefined)) } as never as OutcomeWriter & {
    postOutcome: ReturnType<typeof vi.fn>;
  };
}

describe('dispatchIssueOutcomeWith', () => {
  const meta = { sourceType: 'alpha' };
  const on = { issueWriteback: { github: true } } as never;
  const off = { issueWriteback: { github: false } } as never;

  it('awaits the matching writer with the built text and normalized settings', async () => {
    let done = false;
    const w = makeWriter('alpha', { settingKey: 'github' }, async () => {
      await new Promise((r) => setTimeout(r, 10));
      done = true;
    });
    await dispatchIssueOutcomeWith({
      title: 'T', prUrl: 'https://x.io/pr/1', project, event: 'review_ready', meta, raw: on, writers: [w]
    });
    expect(done).toBe(true);
    expect(w.postOutcome).toHaveBeenCalledWith({
      meta,
      project,
      event: 'review_ready',
      text: buildOutcomeComment('review_ready', 'T', 'https://x.io/pr/1'),
      settings: normalizeIssueWritebackSettings({ github: true })
    });
  });

  it('skips pr_opened, account pauses, null meta, disabled settings and unknown sources', async () => {
    const w = makeWriter('alpha', { settingKey: 'github' });
    await dispatchIssueOutcomeWith({ project, event: 'pr_opened', meta, raw: on, writers: [w] });
    await dispatchIssueOutcomeWith({ project, event: 'account_required', meta, raw: on, writers: [w] });
    await dispatchIssueOutcomeWith({ project, event: 'failed', meta: null, raw: on, writers: [w] });
    await dispatchIssueOutcomeWith({ project, event: 'failed', meta, raw: off, writers: [w] });
    await dispatchIssueOutcomeWith({ project, event: 'failed', meta: { sourceType: 'zzz' }, raw: on, writers: [w] });
    expect(w.postOutcome).not.toHaveBeenCalled();
  });

  it('uses isEnabled on the raw settings when a writer defines it', async () => {
    const w = makeWriter('alpha', { isEnabled: (raw) => raw.jiraWriteback?.enabled === true });
    await dispatchIssueOutcomeWith({ project, event: 'failed', meta, raw: on, writers: [w] });
    expect(w.postOutcome).not.toHaveBeenCalled();
    const raw = { jiraWriteback: { enabled: true } } as never;
    await dispatchIssueOutcomeWith({ project, event: 'failed', meta, raw, writers: [w] });
    expect(w.postOutcome).toHaveBeenCalledTimes(1);
    expect(anyWriterEnabled([w], raw)).toBe(true);
    expect(anyWriterEnabled([w], on)).toBe(false);
  });

  it('dispatches an azure_boards task only when settings.azureboards is true', async () => {
    const w = makeWriter('azure_boards', { settingKey: 'azureboards' });
    const azMeta = { sourceType: 'azure_boards' };
    const args = { project, event: 'failed' as const, meta: azMeta, writers: [w] };
    await dispatchIssueOutcomeWith({ ...args, raw: { issueWriteback: { azureboards: false } } as never });
    expect(w.postOutcome).not.toHaveBeenCalled();
    await dispatchIssueOutcomeWith({ ...args, raw: { issueWriteback: { azureboards: true } } as never });
    expect(w.postOutcome).toHaveBeenCalledTimes(1);
  });

  it('never throws', async () => {
    const w = makeWriter('alpha', { settingKey: 'github' }, async () => {
      throw new Error('boom');
    });
    await expect(
      dispatchIssueOutcomeWith({ project, event: 'failed', meta, raw: on, writers: [w] })
    ).resolves.toBeUndefined();
  });
});
