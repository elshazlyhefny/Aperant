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
let specDirs: string[] = [];

vi.mock('../../../settings-utils', () => ({ readSettingsFile: (...a: unknown[]) => readSettingsFile(...a) }));
vi.mock('../../../task-failure-facts', () => ({ taskSpecDirs: () => specDirs }));
vi.mock('../../../app-logger', () => ({
  appLog: { warn: (...a: unknown[]) => warnMock(...a), info: vi.fn(), error: vi.fn() }
}));
vi.mock('../../github/utils', async (orig) => ({
  ...(await orig<typeof import('../../github/utils')>()),
  getGitHubConfig: (...a: unknown[]) => getGitHubConfig(...a),
  githubFetch: (...a: unknown[]) => githubFetch(...a)
}));
vi.mock('../../gitlab/utils', async (orig) => ({
  ...(await orig<typeof import('../../gitlab/utils')>()),
  getGitLabConfig: (...a: unknown[]) => getGitLabConfig(...a),
  gitlabFetch: (...a: unknown[]) => gitlabFetch(...a)
}));
vi.mock('../../linear-client', () => ({
  getLinearApiKey: (...a: unknown[]) => getLinearApiKey(...a),
  linearGraphQL: (...a: unknown[]) => linearGraphQL(...a)
}));

import { dispatchIssueOutcome } from '../issue-writeback';
import { buildOutcomeComment } from '../common';

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
const task = { specId: '001-x', title: 'My task', metadata: { prUrl: PR } } as never;
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
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function run(event: 'review_ready' | 'failed' | 'blocked' | 'pr_opened' = 'review_ready') {
  dispatchIssueOutcome({ task, project, event });
  await flush();
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

  it('ignores pr_opened, which is webhook-only', async () => {
    await run('pr_opened');
    expectNoCalls();
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
});
