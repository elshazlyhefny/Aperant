import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const readSettingsFile = vi.fn();
const getGitHubConfig = vi.fn();
const githubFetch = vi.fn();
const getGitLabConfig = vi.fn();
const gitlabFetch = vi.fn();
const getLinearApiKey = vi.fn();
const linearGraphQL = vi.fn();
const warnMock = vi.fn();
const getJiraConfig = vi.fn();
const addIssueComment = vi.fn();
const transitionIssue = vi.fn();
let specDirs: string[] = [];

vi.mock('../../../settings-utils', () => ({ readSettingsFile: (...a: unknown[]) => readSettingsFile(...a) }));
vi.mock('../../../task-failure-facts', () => ({ taskSpecDirs: () => specDirs }));
vi.mock('../../github/utils', async (orig) => ({
  ...(await orig<typeof import('../../github/utils')>()),
  getGitHubConfig: (...a: unknown[]) => getGitHubConfig(...a)
}));
vi.mock('../../github/github-api', async (orig) => ({
  ...(await orig<typeof import('../../github/github-api')>()),
  githubFetch: (...a: unknown[]) => githubFetch(...a)
}));
vi.mock('../../gitlab/utils', async (orig) => ({
  ...(await orig<typeof import('../../gitlab/utils')>()),
  getGitLabConfig: (...a: unknown[]) => getGitLabConfig(...a)
}));
vi.mock('../../gitlab/gitlab-api', async (orig) => ({
  ...(await orig<typeof import('../../gitlab/gitlab-api')>()),
  gitlabFetch: (...a: unknown[]) => gitlabFetch(...a)
}));
vi.mock('../../jira/jira-config', () => ({ getJiraConfig: (...a: unknown[]) => getJiraConfig(...a) }));
vi.mock('../../jira/jira-client', async (orig) => ({
  ...(await orig<typeof import('../../jira/jira-client')>()),
  addIssueComment: (...a: unknown[]) => addIssueComment(...a),
  transitionIssue: (...a: unknown[]) => transitionIssue(...a)
}));
vi.mock('../../linear-client', () => ({
  getLinearApiKey: (...a: unknown[]) => getLinearApiKey(...a),
  linearGraphQL: (...a: unknown[]) => linearGraphQL(...a)
}));

import { dispatchIssueOutcome } from '../issue-writeback';
import { createDeliveryReceiptRecorder, readDeliveryReceipts } from '../../../delivery-receipts';
import { buildOutcomeComment } from '../common';
import { appLogPort, setLogger } from '../../../log-port';

const defaultLogger = { ...appLogPort };

const TOKEN = 'secret-token-123';
const PR = 'https://github.com/o/r/pull/1';
let dir: string;

function writeMeta(meta: unknown) {
  writeFileSync(path.join(dir, 'task_metadata.json'), typeof meta === 'string' ? meta : JSON.stringify(meta));
}
const ghMeta = { sourceType: 'github', githubIssueNumber: 12, githubUrl: 'https://github.com/Owner/Repo/issues/12' };
const glMeta = { sourceType: 'gitlab', gitlabIssueIid: 5, gitlabUrl: 'https://gitlab.example.com/grp/proj/-/issues/5' };
const lnMeta = { sourceType: 'linear', linearIssueId: 'abc-123' };

function settings(over: Record<string, unknown> = {}) {
  readSettingsFile.mockReturnValue({ issueWriteback: { github: false, gitlab: false, linear: false, ...over } });
}
const specId = '001-x';
const task = { specId, title: 'My task', metadata: { prUrl: PR } } as never;
const project = { path: '/p', autoBuildPath: '.auto-claude' } as never;
const flush = () => new Promise((r) => setTimeout(r, 10));
const expectedText = buildOutcomeComment('review_ready', 'My task', PR);

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iwb-'));
  mkdirSync(dir, { recursive: true });
  specDirs = [dir];
  writeMeta(ghMeta);
  settings({ github: true, gitlab: true, linear: true });
  getGitHubConfig.mockReturnValue({ token: TOKEN, repo: 'owner/repo' });
  getGitLabConfig.mockResolvedValue({
    token: TOKEN,
    instanceUrl: 'https://gitlab.example.com',
    project: 'grp/proj'
  });
  getLinearApiKey.mockReturnValue(TOKEN);
  githubFetch.mockReset().mockResolvedValue({});
  gitlabFetch.mockReset().mockResolvedValue({});
  linearGraphQL.mockReset().mockResolvedValue({ commentCreate: { success: true } });
  warnMock.mockReset();
  getJiraConfig.mockReturnValue({ siteUrl: 'https://acme.atlassian.net', email: 'a@b.c', token: TOKEN });
  addIssueComment.mockReset().mockResolvedValue(undefined);
  transitionIssue.mockReset().mockResolvedValue({ transitioned: true });
  setLogger({ ...defaultLogger, warn: (...a: unknown[]) => warnMock(...a) });
});
afterEach(() => {
  setLogger(defaultLogger);
  rmSync(dir, { recursive: true, force: true });
});

async function run(event: 'review_ready' | 'failed' | 'blocked' | 'account_required' | 'pr_opened' = 'review_ready') {
  await dispatchIssueOutcome({ task, project, event });
}
function expectNoCalls() {
  expect(githubFetch).not.toHaveBeenCalled();
  expect(gitlabFetch).not.toHaveBeenCalled();
  expect(linearGraphQL).not.toHaveBeenCalled();
}

describe('dispatchIssueOutcome', () => {
  it('does nothing by default', async () => {
    readSettingsFile.mockReturnValue({});
    await run();
    expectNoCalls();
  });

  it('does nothing when all flags are false', async () => {
    settings();
    await run();
    expectNoCalls();
  });

  it('posts a GitHub comment', async () => {
    await run();
    expect(githubFetch).toHaveBeenCalledWith(TOKEN, '/repos/owner/repo/issues/12/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: expectedText })
    });
    expect(gitlabFetch).not.toHaveBeenCalled();
    expect(linearGraphQL).not.toHaveBeenCalled();
  });

  it('passes the recorder through to the enabled writer', async () => {
    const recorder = createDeliveryReceiptRecorder(dir, specId);
    await dispatchIssueOutcome({ task, project, event: 'review_ready' }, recorder);

    expect(githubFetch).toHaveBeenCalledTimes(1);
    const receipts = await readDeliveryReceipts(dir, specId);
    expect(receipts).toEqual([expect.objectContaining({
      operation: 'issue_comment', event: 'review_ready', provider: 'github', status: 'delivered'
    })]);
    expect(JSON.stringify(receipts)).not.toContain(TOKEN);
  });

  it('does not record webhook-only events or completely opted-out write-back', async () => {
    const recorder = createDeliveryReceiptRecorder(dir, specId);
    await dispatchIssueOutcome({ task, project, event: 'pr_opened' }, recorder);
    await dispatchIssueOutcome({ task, project, event: 'account_required' }, recorder);
    settings();
    await dispatchIssueOutcome({ task, project, event: 'review_ready' }, recorder);

    expectNoCalls();
    expect(recorder.snapshot()).toEqual([]);
  });

  it('ignores pr_opened, which is webhook-only', async () => {
    await run('pr_opened');
    expectNoCalls();
  });

  it('ignores an account pause, which is webhook-only', async () => {
    for (const meta of [ghMeta, glMeta, lnMeta]) {
      writeMeta(meta);
      await run('account_required');
    }
    expectNoCalls();
    expect(addIssueComment).not.toHaveBeenCalled();
  });

  it('posts a GitLab note', async () => {
    writeMeta(glMeta);
    await run();
    expect(gitlabFetch).toHaveBeenCalledWith(
      TOKEN,
      'https://gitlab.example.com',
      '/projects/grp%2Fproj/issues/5/notes',
      { method: 'POST', body: JSON.stringify({ body: expectedText }) }
    );
    expect(githubFetch).not.toHaveBeenCalled();
    expect(linearGraphQL).not.toHaveBeenCalled();
  });

  it('posts a Linear comment', async () => {
    writeMeta(lnMeta);
    await run();
    expect(linearGraphQL).toHaveBeenCalledWith(
      TOKEN,
      expect.stringContaining('commentCreate'),
      { input: { issueId: 'abc-123', body: expectedText } }
    );
    expect(githubFetch).not.toHaveBeenCalled();
    expect(gitlabFetch).not.toHaveBeenCalled();
  });

  it('only triggers the enabled provider', async () => {
    settings({ gitlab: true });
    await run();
    expectNoCalls();
    writeMeta(glMeta);
    await run();
    expect(gitlabFetch).toHaveBeenCalledTimes(1);
  });

  it('ignores a mismatched source type', async () => {
    settings({ github: true });
    writeMeta(lnMeta);
    await run();
    expectNoCalls();
  });

  it('skips GitHub on repo mismatch', async () => {
    writeMeta({ ...ghMeta, githubUrl: 'https://github.com/evil/repo/issues/12' });
    await run();
    expectNoCalls();
  });

  it('skips GitHub on non-github host', async () => {
    writeMeta({ ...ghMeta, githubUrl: 'https://evil.com/Owner/Repo/issues/12' });
    await run();
    expectNoCalls();
  });

  it('skips GitLab on host mismatch', async () => {
    writeMeta({ ...glMeta, gitlabUrl: 'https://evil.example.org/grp/proj/-/issues/5' });
    await run();
    expectNoCalls();
  });

  it.each([0, -1, 1.5, '12', Number.MAX_SAFE_INTEGER + 2])('rejects invalid github number %s', async (n) => {
    writeMeta({ ...ghMeta, githubIssueNumber: n });
    await run();
    expectNoCalls();
  });

  it.each([0, -3, 2.5, '5'])('rejects invalid gitlab iid %s', async (n) => {
    writeMeta({ ...glMeta, gitlabIssueIid: n });
    await run();
    expectNoCalls();
  });

  it.each(['', 'a b', 'a/b', 'x'.repeat(101), 5])('rejects invalid linear id %s', async (id) => {
    writeMeta({ ...lnMeta, linearIssueId: id });
    await run();
    expectNoCalls();
  });

  it('does nothing without config', async () => {
    getGitHubConfig.mockReturnValue(null);
    await run();
    writeMeta(glMeta);
    getGitLabConfig.mockResolvedValue(null);
    await run();
    writeMeta(lnMeta);
    getLinearApiKey.mockReturnValue(null);
    await run();
    expectNoCalls();
  });

  it('swallows client rejections and does not leak the token', async () => {
    githubFetch.mockRejectedValue(new Error(`GitHub API error: 500 - ${TOKEN}`));
    gitlabFetch.mockRejectedValue(new Error(TOKEN));
    linearGraphQL.mockRejectedValue(new Error(TOKEN));
    for (const m of [ghMeta, glMeta, lnMeta]) {
      writeMeta(m);
      expect(() => dispatchIssueOutcome({ task, project, event: 'failed' })).not.toThrow();
      await flush();
    }
    expect(warnMock).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(warnMock.mock.calls)).not.toContain(TOKEN);
  });

  it('treats Linear success=false as a failure', async () => {
    writeMeta(lnMeta);
    linearGraphQL.mockResolvedValue({ commentCreate: { success: false } });
    await run();
    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it('does not throw on malformed metadata', async () => {
    writeMeta('{not json');
    expect(() => dispatchIssueOutcome({ task, project, event: 'failed' })).not.toThrow();
    await flush();
    expectNoCalls();
  });

  it('does not throw when settings read throws', () => {
    readSettingsFile.mockImplementation(() => {
      throw new Error('x');
    });
    expect(() => dispatchIssueOutcome({ task, project, event: 'failed' })).not.toThrow();
  });

  it('excludes non-https PR URLs from the comment', async () => {
    const t = { specId: '001-x', title: 'T', metadata: { prUrl: 'http://example.com/pr/1' } } as never;
    dispatchIssueOutcome({ task: t, project, event: 'failed' });
    await flush();
    expect(githubFetch).toHaveBeenCalledTimes(1);
    expect(String(githubFetch.mock.calls[0][2].body)).not.toContain('example.com');
  });

  it('posts a Jira comment when jiraWriteback.enabled is set, independent of issueWriteback flags', async () => {
    readSettingsFile.mockReturnValue({
      issueWriteback: { github: false, gitlab: false, linear: false },
      jiraWriteback: { enabled: true, comment: true, transitionOnReview: false, transitionStatusName: '' }
    });
    writeMeta({ sourceType: 'jira', jiraIssueKey: 'PROJ-7', jiraSiteUrl: 'https://acme.atlassian.net' });
    await run();
    expect(addIssueComment).toHaveBeenCalledWith(
      'https://acme.atlassian.net', 'a@b.c', TOKEN, 'PROJ-7', expectedText
    );
    expectNoCalls();
  });
});

describe('Linear transition on review', () => {
  const states = {
    issue: {
      team: {
        states: {
          nodes: [
            { id: 'st-1', name: 'Todo' },
            { id: 'st-2', name: 'In Review' }
          ]
        }
      }
    }
  };
  const isStates = (q: unknown) => String(q).includes('states');
  const isUpdate = (q: unknown) => String(q).includes('issueUpdate');
  const queriesOf = () => linearGraphQL.mock.calls.map((c) => String(c[1]));

  function transitionSettings(over: Record<string, unknown> = {}) {
    settings({
      linear: true,
      linearTransitionOnReview: true,
      linearTransitionStateName: 'In Review',
      ...over
    });
  }
  function mockLinear(opts: { comment?: unknown; update?: unknown } = {}) {
    linearGraphQL.mockImplementation(async (_k: unknown, q: unknown) => {
      if (isStates(q)) return states;
      if (isUpdate(q)) {
        if (opts.update instanceof Error) throw opts.update;
        return opts.update ?? { issueUpdate: { success: true } };
      }
      if (opts.comment instanceof Error) throw opts.comment;
      return opts.comment ?? { commentCreate: { success: true } };
    });
  }

  beforeEach(() => {
    writeMeta(lnMeta);
    transitionSettings();
    mockLinear();
  });

  it('matches the state name ignoring case and whitespace', async () => {
    transitionSettings({ linearTransitionStateName: '  in REVIEW ' });
    await run();
    expect(linearGraphQL).toHaveBeenCalledTimes(3);
    expect(isStates(linearGraphQL.mock.calls[1][1])).toBe(true);
    expect(linearGraphQL.mock.calls[1][2]).toEqual({ id: 'abc-123' });
    expect(isUpdate(linearGraphQL.mock.calls[2][1])).toBe(true);
    expect(linearGraphQL.mock.calls[2][2]).toEqual({ id: 'abc-123', input: { stateId: 'st-2' } });
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('does nothing further when no state matches', async () => {
    transitionSettings({ linearTransitionStateName: 'Nope' });
    await run();
    expect(queriesOf().some(isUpdate)).toBe(false);
    expect(queriesOf().some(isStates)).toBe(true);
    expect(linearGraphQL).toHaveBeenCalledTimes(2);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('warns once without leaking the token when issueUpdate rejects', async () => {
    mockLinear({ update: new Error(TOKEN) });
    expect(() => dispatchIssueOutcome({ task, project, event: 'review_ready' })).not.toThrow();
    await flush();
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(String(warnMock.mock.calls[0][0])).toContain('transition');
    expect(JSON.stringify(warnMock.mock.calls)).not.toContain(TOKEN);
  });

  it('warns when issueUpdate returns success=false', async () => {
    mockLinear({ update: { issueUpdate: { success: false } } });
    await run();
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(String(warnMock.mock.calls[0][0])).toContain('transition');
  });

  it('skips the transition when the toggle is off', async () => {
    transitionSettings({ linearTransitionOnReview: false });
    await run();
    expect(queriesOf().some(isStates)).toBe(false);
    expect(queriesOf().some(isUpdate)).toBe(false);
  });

  it.each(['failed', 'blocked'] as const)('skips the transition on %s', async (event) => {
    await run(event);
    expect(queriesOf().some(isStates)).toBe(false);
    expect(queriesOf().some(isUpdate)).toBe(false);
  });

  it('still attempts the transition when the comment fails', async () => {
    mockLinear({ comment: new Error(TOKEN) });
    await run();
    expect(queriesOf().some(isUpdate)).toBe(true);
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(String(warnMock.mock.calls[0][0])).toContain('comment');
  });
});
