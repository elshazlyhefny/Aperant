/**
 * zeenha fork: the Electron-free Jira writer resolves only after its requests
 * finish, so the headless CLI can await it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const addIssueComment = vi.fn();
const transitionIssue = vi.fn();

vi.mock('../../jira/jira-client', async (orig) => ({
  ...(await orig<typeof import('../../jira/jira-client')>()),
  addIssueComment: (...a: unknown[]) => addIssueComment(...a),
  transitionIssue: (...a: unknown[]) => transitionIssue(...a)
}));

import { createJiraWriter } from '../jira-writer';

const SITE = 'https://acme.atlassian.net';
const meta = { sourceType: 'jira', jiraIssueKey: 'PROJ-7', jiraSiteUrl: SITE };
const jira = { enabled: true, comment: true, transitionOnReview: true, transitionStatusName: 'In Review' };
const settings = {} as never;
const project = { path: '/p' } as never;
const getConfig = () => ({ siteUrl: SITE, email: 'a@b.c', token: 'tok' }) as never;
const writer = (over: Partial<typeof jira> = {}, cfg: typeof getConfig | (() => null) = getConfig) =>
  createJiraWriter(() => ({ ...jira, ...over }), cfg);

beforeEach(() => {
  addIssueComment.mockReset().mockResolvedValue(undefined);
  transitionIssue.mockReset().mockResolvedValue({ transitioned: true });
});

describe('createJiraWriter', () => {
  it('resolves only after the comment and transition finish', async () => {
    let done = false;
    transitionIssue.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      done = true;
    });
    await writer().postOutcome({ meta, project, event: 'review_ready', text: 'T', settings });
    expect(done).toBe(true);
    expect(addIssueComment).toHaveBeenCalledWith(SITE, 'a@b.c', 'tok', 'PROJ-7', 'T');
    expect(transitionIssue).toHaveBeenCalledWith(SITE, 'a@b.c', 'tok', 'PROJ-7', 'In Review');
  });

  it('comments only on failed', async () => {
    await writer().postOutcome({ meta, project, event: 'failed', text: 'T', settings });
    expect(addIssueComment).toHaveBeenCalledTimes(1);
    expect(transitionIssue).not.toHaveBeenCalled();
  });

  it('skips on site mismatch, missing config and pr_opened', async () => {
    const base = { meta, project, event: 'review_ready' as const, text: 'T', settings };
    await writer().postOutcome({ ...base, meta: { ...meta, jiraSiteUrl: 'https://evil.atlassian.net' } });
    await writer({}, () => null).postOutcome(base);
    await writer().postOutcome({ ...base, event: 'pr_opened' });
    expect(addIssueComment).not.toHaveBeenCalled();
    expect(transitionIssue).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    addIssueComment.mockRejectedValue(new Error('x'));
    const throwing = createJiraWriter(() => jira, () => {
      throw new Error('y');
    });
    await expect(
      Promise.resolve(throwing.postOutcome({ meta, project, event: 'failed', text: 'T', settings }))
    ).resolves.toBeUndefined();
  });
});
