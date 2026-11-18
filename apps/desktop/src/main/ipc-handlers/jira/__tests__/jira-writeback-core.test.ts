import { describe, it, expect, vi, beforeEach } from 'vitest';

const addIssueComment = vi.fn();
const transitionIssue = vi.fn();

vi.mock('../jira-client', async (orig) => ({
  ...(await orig<typeof import('../jira-client')>()),
  addIssueComment: (...a: unknown[]) => addIssueComment(...a),
  transitionIssue: (...a: unknown[]) => transitionIssue(...a)
}));

import { dispatchJiraOutcomeWith, normalizeJiraWritebackSettings } from '../jira-writeback-core';

const SITE = 'https://acme.atlassian.net';
const meta = { sourceType: 'jira', jiraIssueKey: 'PROJ-7', jiraSiteUrl: SITE };
const settings = { enabled: true, comment: true, transitionOnReview: true, transitionStatusName: 'In Review' };
const project = { path: '/p' } as never;
const getConfig = () => ({ siteUrl: SITE, email: 'a@b.c', token: 'tok' }) as never;

beforeEach(() => {
  addIssueComment.mockReset().mockResolvedValue(undefined);
  transitionIssue.mockReset().mockResolvedValue({ transitioned: true });
});

describe('dispatchJiraOutcomeWith', () => {
  it('resolves only after the comment and transition finish', async () => {
    let done = false;
    transitionIssue.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      done = true;
    });
    await dispatchJiraOutcomeWith({ title: 'T', project, event: 'review_ready', meta, settings, getConfig });
    expect(done).toBe(true);
    expect(addIssueComment).toHaveBeenCalledTimes(1);
    expect(transitionIssue).toHaveBeenCalledWith(SITE, 'a@b.c', 'tok', 'PROJ-7', 'In Review');
  });

  it('comments only on failed', async () => {
    await dispatchJiraOutcomeWith({ project, event: 'failed', meta, settings, getConfig });
    expect(addIssueComment).toHaveBeenCalledTimes(1);
    expect(transitionIssue).not.toHaveBeenCalled();
  });

  it('skips on disabled, null meta, site mismatch and missing config', async () => {
    const base = { project, event: 'review_ready' as const, meta, settings, getConfig };
    await dispatchJiraOutcomeWith({ ...base, settings: { ...settings, enabled: false } });
    await dispatchJiraOutcomeWith({ ...base, meta: null });
    await dispatchJiraOutcomeWith({ ...base, meta: { ...meta, jiraSiteUrl: 'https://evil.atlassian.net' } });
    await dispatchJiraOutcomeWith({ ...base, getConfig: () => null });
    await dispatchJiraOutcomeWith({ ...base, event: 'pr_opened' });
    expect(addIssueComment).not.toHaveBeenCalled();
    expect(transitionIssue).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    addIssueComment.mockRejectedValue(new Error('x'));
    await expect(
      dispatchJiraOutcomeWith({ project, event: 'failed', meta, settings, getConfig: () => { throw new Error('y'); } })
    ).resolves.toBeUndefined();
  });
});

describe('normalizeJiraWritebackSettings', () => {
  it('defaults to disabled', () => {
    expect(normalizeJiraWritebackSettings(undefined).enabled).toBe(false);
    expect(normalizeJiraWritebackSettings({ jiraWriteback: { enabled: true } }).enabled).toBe(true);
  });
});
