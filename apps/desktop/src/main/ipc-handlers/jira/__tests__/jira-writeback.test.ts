import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const readSettingsFile = vi.fn();
const getJiraConfig = vi.fn();
const addIssueComment = vi.fn();
const transitionIssue = vi.fn();
let specDirs: string[] = [];
const jiraClient = vi.hoisted(() => ({ real: undefined as typeof import('../jira-client') | undefined }));

vi.mock('../../../settings-utils', () => ({ readSettingsFile: (...a: unknown[]) => readSettingsFile(...a) }));
vi.mock('../jira-config', () => ({ getJiraConfig: (...a: unknown[]) => getJiraConfig(...a) }));
vi.mock('../../../task-failure-facts', () => ({ taskSpecDirs: () => specDirs }));
vi.mock('../jira-client', async (orig) => {
  const real = await orig<typeof import('../jira-client')>();
  jiraClient.real = real;
  return {
    ...real,
    addIssueComment: (...a: unknown[]) => addIssueComment(...a),
    transitionIssue: (...a: unknown[]) => transitionIssue(...a),
  };
});

import { createDeliveryReceiptRecorder, readDeliveryReceipts } from '../../../delivery-receipts';
import { buildJiraComment, jiraWriter } from '../jira-writeback';
import { dispatchIssueOutcome } from '../../issue-writeback/issue-writeback';
import { appLogPort, setLogger } from '../../../log-port';

const defaultLogger = { ...appLogPort };
const warnMock = vi.fn();

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
  addIssueComment.mockReset().mockResolvedValue({ confirmed: true, httpStatus: 201 });
  transitionIssue.mockReset().mockResolvedValue({ transitioned: true, httpStatus: 204 });
  warnMock.mockReset();
  setLogger({ ...defaultLogger, warn: (...a: unknown[]) => warnMock(...a) });
});
afterEach(() => {
  vi.unstubAllGlobals();
  setLogger(defaultLogger);
  rmSync(dir, { recursive: true, force: true });
});

async function run(event: 'review_ready' | 'failed' | 'blocked' = 'review_ready') {
  dispatchIssueOutcome({ task, project, event });
  await flush();
}

describe('dispatchIssueOutcome for jira', () => {
  it('sends nothing for the webhook-only pr_opened event', async () => {
    dispatchIssueOutcome({ task, project, event: 'pr_opened' });
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

  it('rejects an invalid issue key', async () => {
    writeMeta({ ...jiraMeta, jiraIssueKey: 'not a key' });
    await run();
    expect(addIssueComment).not.toHaveBeenCalled();
    expect(transitionIssue).not.toHaveBeenCalled();
  });

  it('skips the transition when transitionOnReview is false', async () => {
    settings({ transitionOnReview: false });
    await run();
    expect(addIssueComment).toHaveBeenCalledTimes(1);
    expect(transitionIssue).not.toHaveBeenCalled();
  });

  it('skips the transition when the status name is empty', async () => {
    settings({ transitionStatusName: '   ' });
    await run();
    expect(addIssueComment).toHaveBeenCalledTimes(1);
    expect(transitionIssue).not.toHaveBeenCalled();
  });

  it('does not fire when only issueWriteback flags are set', async () => {
    readSettingsFile.mockReturnValue({ issueWriteback: { github: true, gitlab: true, linear: true } });
    await run();
    expect(addIssueComment).not.toHaveBeenCalled();
    expect(transitionIssue).not.toHaveBeenCalled();
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
    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it('does not throw on malformed metadata', async () => {
    writeMeta('{not json');
    expect(() => dispatchIssueOutcome({ task, project, event: 'failed' })).not.toThrow();
    await flush();
    expect(addIssueComment).not.toHaveBeenCalled();
  });

  it('does not throw when settings read throws', () => {
    readSettingsFile.mockImplementation(() => {
      throw new Error('x');
    });
    expect(() => dispatchIssueOutcome({ task, project, event: 'failed' })).not.toThrow();
  });
});

describe('jiraWriter', () => {
  it('isEnabled is true only for jiraWriteback.enabled === true', () => {
    expect(jiraWriter.isEnabled?.({ jiraWriteback: { enabled: true } } as never)).toBe(true);
    expect(jiraWriter.isEnabled?.({ jiraWriteback: { enabled: false } } as never)).toBe(false);
    expect(jiraWriter.isEnabled?.({ jiraWriteback: { enabled: 'true' } } as never)).toBe(false);
    expect(jiraWriter.isEnabled?.({ issueWriteback: { github: true } } as never)).toBe(false);
    expect(jiraWriter.isEnabled?.({} as never)).toBe(false);
  });

  it('postOutcome never throws on bad input', () => {
    expect(() => jiraWriter.postOutcome({ meta: {}, project, event: 'failed', text: 't' } as never)).not.toThrow();
    expect(() =>
      jiraWriter.postOutcome({ meta: { jiraIssueKey: 5 }, project: undefined, event: 'failed', text: 't' } as never)
    ).not.toThrow();
    expect(addIssueComment).not.toHaveBeenCalled();
  });
});

describe('Jira writeback receipts', () => {
  const specId = '001-jira';
  async function record(meta = jiraMeta) {
    await jiraWriter.postOutcome({
      meta, project, event: 'review_ready', text: 'private fixture comment', settings: {} as never,
      recorder: createDeliveryReceiptRecorder(dir, specId)
    });
    return (await readDeliveryReceipts(dir, specId)).sort((a, b) => a.operation.localeCompare(b.operation));
  }

  it('records a transition-only no-match as skipped', async () => {
    settings({ comment: false });
    transitionIssue.mockResolvedValueOnce({ transitioned: false, reason: 'transition_not_available' });
    expect(await record()).toEqual([
      expect.objectContaining({ operation: 'issue_transition', provider: 'jira', status: 'skipped', reason: 'state_unavailable' })
    ]);
    expect(addIssueComment).not.toHaveBeenCalled();
    expect(transitionIssue).toHaveBeenCalledTimes(1);
  });

  it('records only the comment when the transition is off', async () => {
    settings({ transitionOnReview: false });
    expect(await record()).toEqual([expect.objectContaining({ operation: 'issue_comment', status: 'delivered' })]);
    expect(transitionIssue).not.toHaveBeenCalled();
  });

  it('skips only enabled operations when the imported site does not match', async () => {
    settings({ comment: false });
    expect(await record({ ...jiraMeta, jiraSiteUrl: 'https://other.atlassian.net' })).toEqual([
      expect.objectContaining({ operation: 'issue_transition', provider: 'jira', status: 'skipped', reason: 'target_mismatch' })
    ]);
    expect(addIssueComment).not.toHaveBeenCalled();
    expect(transitionIssue).not.toHaveBeenCalled();
  });

  it.each([
    { commentStatus: 202, body: {}, transitionStatus: 202, commentConfirmed: false },
    { commentStatus: 201, body: { id: 'fixture-comment-id' }, transitionStatus: 204, commentConfirmed: true },
    { commentStatus: 201, body: {}, transitionStatus: 204, commentConfirmed: false },
    { commentStatus: 201, body: { id: 'fixture-comment-id' }, transitionStatus: 202, commentConfirmed: true },
  ])('classifies comment $commentStatus ($commentConfirmed) and transition $transitionStatus independently', async ({
    commentStatus, body, transitionStatus, commentConfirmed,
  }) => {
    const real = jiraClient.real;
    if (!real) throw new Error('Missing real Jira client fixture');
    addIssueComment.mockImplementationOnce(real.addIssueComment);
    transitionIssue.mockImplementationOnce(real.transitionIssue);
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(body, { status: commentStatus }))
      .mockResolvedValueOnce(Response.json({ transitions: [{ id: '31', to: { name: 'In Review' } }] }))
      .mockResolvedValueOnce(transitionStatus === 204
        ? new Response(null, { status: transitionStatus })
        : Response.json({}, { status: transitionStatus }));
    vi.stubGlobal('fetch', fetchMock);

    const receipts = await record();
    expect(receipts).toEqual([
      expect.objectContaining({
        operation: 'issue_comment', attempts: 1, httpStatus: commentStatus,
        ...(commentConfirmed ? { status: 'delivered' } : { status: 'unknown', reason: 'ambiguous_response' }),
      }),
      expect.objectContaining({
        operation: 'issue_transition', attempts: 1, httpStatus: transitionStatus,
        ...(transitionStatus === 204 ? { status: 'delivered' } : { status: 'unknown', reason: 'ambiguous_response' }),
      }),
    ]);
    const issue = `${SITE}/rest/api/3/issue/PROJ-7`;
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [`${issue}/comment`, 'POST'], [`${issue}/transitions`, 'GET'], [`${issue}/transitions`, 'POST'],
    ]);
    expect(JSON.stringify(receipts)).not.toContain('fixture-comment-id');
  });

  it.each(['lookup timeout', 'write timeout', 'invalid response', 'confirmed'] as const)(
    'records independent results with the real client (%s)', async (scenario) => {
      const real = jiraClient.real;
      if (!real) throw new Error('Missing real Jira client fixture');
      addIssueComment.mockImplementationOnce(real.addIssueComment);
      transitionIssue.mockImplementationOnce(real.transitionIssue);
      const privateDiagnostic = 'private fixture response';
      const timeout = new DOMException(privateDiagnostic, 'TimeoutError');
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(privateDiagnostic, { status: 429 }));
      if (scenario === 'lookup timeout') {
        fetchMock.mockRejectedValueOnce(timeout);
      } else {
        fetchMock.mockResolvedValueOnce(Response.json({ transitions: [{ id: '31', to: { name: 'In Review' } }] }));
        if (scenario === 'write timeout') fetchMock.mockRejectedValueOnce(timeout);
        if (scenario === 'invalid response') fetchMock.mockResolvedValueOnce(new Response(privateDiagnostic, { status: 200 }));
        if (scenario === 'confirmed') fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
      }
      vi.stubGlobal('fetch', fetchMock);

      const [comment, transition] = await record();
      expect(comment).toMatchObject({ operation: 'issue_comment', status: 'failed', reason: 'rate_limited', httpStatus: 429 });
      expect(transition.operation).toBe('issue_transition');
      expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(
        scenario === 'lookup timeout' ? ['POST', 'GET'] : ['POST', 'GET', 'POST']
      );
      if (scenario === 'lookup timeout') {
        expect(transition).toMatchObject({ status: 'failed', reason: 'lookup_failed' });
        expect(transition.attempts).toBeUndefined();
      } else if (scenario === 'confirmed') {
        expect(transition).toMatchObject({ status: 'delivered', attempts: 1 });
      } else {
        expect(transition).toMatchObject({
          status: 'unknown', reason: scenario === 'write timeout' ? 'timeout' : 'ambiguous_response', attempts: 1
        });
      }
      expect(JSON.stringify([comment, transition])).not.toContain(privateDiagnostic);
    }
  );
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
