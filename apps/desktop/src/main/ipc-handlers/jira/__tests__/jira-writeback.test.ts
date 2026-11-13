import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const readSettingsFile = vi.fn();
const getJiraConfig = vi.fn();
const addIssueComment = vi.fn();
const transitionIssue = vi.fn();
let specDirs: string[] = [];

vi.mock('../../../settings-utils', () => ({ readSettingsFile: (...a: unknown[]) => readSettingsFile(...a) }));
vi.mock('../jira-config', () => ({ getJiraConfig: (...a: unknown[]) => getJiraConfig(...a) }));
vi.mock('../../../task-failure-facts', () => ({ taskSpecDirs: () => specDirs }));
vi.mock('../../../app-logger', () => ({ appLog: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../jira-client', async (orig) => ({
  ...(await orig<typeof import('../jira-client')>()),
  addIssueComment: (...a: unknown[]) => addIssueComment(...a),
  transitionIssue: (...a: unknown[]) => transitionIssue(...a),
}));

import { buildJiraComment, dispatchJiraOutcome } from '../jira-writeback';

const SITE = 'https://acme.atlassian.net';
let dir: string;

function writeMeta(meta: unknown) {
  writeFileSync(path.join(dir, 'task_metadata.json'), typeof meta === 'string' ? meta : JSON.stringify(meta));
}
const jiraMeta = { sourceType: 'jira', jiraIssueKey: 'PROJ-7', jiraSiteUrl: SITE };
function settings(over: Record<string, unknown> = {}) {
  readSettingsFile.mockReturnValue({
    jiraWriteback: { enabled: true, comment: true, transitionOnReview: true, transitionStatusName: 'In Review', ...over },
  });
}
const task = { specId: '001-x', title: 'My task', metadata: { prUrl: 'https://github.com/o/r/pull/1' } } as never;
const project = { path: '/p', autoBuildPath: '.auto-claude' } as never;
const flush = () => new Promise((r) => setTimeout(r, 10));

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'jwb-'));
  mkdirSync(dir, { recursive: true });
  specDirs = [dir];
  writeMeta(jiraMeta);
  settings();
  getJiraConfig.mockReturnValue({ siteUrl: SITE, email: 'a@b.c', token: 'tok' });
  addIssueComment.mockReset().mockResolvedValue(undefined);
  transitionIssue.mockReset().mockResolvedValue({ transitioned: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function run(event: 'review_ready' | 'failed' | 'blocked' = 'review_ready') {
  dispatchJiraOutcome({ task, project, event });
  await flush();
}

describe('dispatchJiraOutcome', () => {
  it('sends nothing for the webhook-only pr_opened event', async () => {
    dispatchJiraOutcome({ task, project, event: 'pr_opened' });
    await flush();
    expect(addIssueComment).not.toHaveBeenCalled();
    expect(transitionIssue).not.toHaveBeenCalled();
  });

  it('does nothing when disabled', async () => {
    settings({ enabled: false });
    await run();
    expect(addIssueComment).not.toHaveBeenCalled();
    expect(transitionIssue).not.toHaveBeenCalled();
  });

  it('does nothing for non-jira source', async () => {
    writeMeta({ ...jiraMeta, sourceType: 'github' });
    await run();
    expect(addIssueComment).not.toHaveBeenCalled();
  });

  it('does nothing on site URL mismatch', async () => {
    writeMeta({ ...jiraMeta, jiraSiteUrl: 'https://evil.atlassian.net' });
    await run();
    expect(addIssueComment).not.toHaveBeenCalled();
  });

  it('does nothing without config', async () => {
    getJiraConfig.mockReturnValue(null);
    await run();
    expect(addIssueComment).not.toHaveBeenCalled();
  });

  it('comments and transitions on review_ready', async () => {
    await run();
    expect(addIssueComment).toHaveBeenCalledWith(
      SITE, 'a@b.c', 'tok', 'PROJ-7',
      buildJiraComment({ event: 'review_ready', taskTitle: 'My task', prUrl: 'https://github.com/o/r/pull/1' })
    );
    expect(transitionIssue).toHaveBeenCalledWith(SITE, 'a@b.c', 'tok', 'PROJ-7', 'In Review');
  });

  it('comments only on failed', async () => {
    await run('failed');
    expect(addIssueComment).toHaveBeenCalledTimes(1);
    expect(transitionIssue).not.toHaveBeenCalled();
  });

  it('transitions only when comment is off', async () => {
    settings({ comment: false });
    await run();
    expect(addIssueComment).not.toHaveBeenCalled();
    expect(transitionIssue).toHaveBeenCalledTimes(1);
  });

  it('still transitions when the comment fails', async () => {
    addIssueComment.mockRejectedValue(new Error('boom'));
    await run();
    expect(transitionIssue).toHaveBeenCalledTimes(1);
  });

  it('does not throw on malformed metadata', async () => {
    writeMeta('{not json');
    expect(() => dispatchJiraOutcome({ task, project, event: 'failed' })).not.toThrow();
    await flush();
    expect(addIssueComment).not.toHaveBeenCalled();
  });

  it('does not throw when settings read throws', () => {
    readSettingsFile.mockImplementation(() => {
      throw new Error('x');
    });
    expect(() => dispatchJiraOutcome({ task, project, event: 'failed' })).not.toThrow();
  });
});

describe('buildJiraComment', () => {
  it('excludes non-https PR URLs', () => {
    const text = buildJiraComment({ event: 'failed', taskTitle: 't', prUrl: 'http://example.com/pr/1' });
    expect(text).not.toContain('example.com');
  });

  it('strips control characters from the title', () => {
    const text = buildJiraComment({ event: 'blocked', taskTitle: 'a\u0000b\nc\u0007d' });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: test
    expect(text.split('\n')[1]).not.toMatch(/[\u0000-\u001f]/);
    expect(text).toContain('Aperant: task is blocked');
  });
});
