/** zeenha fork: use real clients and receipt persistence with mocked HTTP responses. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDeliveryReceiptRecorder,
  type DeliveryReceiptRecorder,
  readDeliveryReceipts
} from '../../../delivery-receipts';
import { createGitHubWriter } from '../github-writer';
import { createGitLabWriter } from '../gitlab-writer';
import type { OutcomeWriter } from '../types';

const spec = '001-comment';
const token = 'fixture-token-private';
const text = 'fixture-comment-private';
const responseBody = 'fixture-body-private';
const targetMarker = 'fixture-target-private';
const fetchMock = vi.fn<typeof fetch>();

const fixtures = [
  {
    provider: 'github',
    makeWriter: (configured: boolean) => createGitHubWriter(() => configured ? { token, repo: 'owner/repo' } : null),
    meta: { githubIssueNumber: 42, githubUrl: `https://github.com/Owner/Repo/issues/42?private=${targetMarker}` },
    numberKey: 'githubIssueNumber',
    urlKey: 'githubUrl',
    endpoint: 'https://api.github.com/repos/owner/repo/issues/42/comments'
  },
  {
    provider: 'gitlab',
    makeWriter: (configured: boolean) => createGitLabWriter(async () => configured
      ? { token, instanceUrl: 'https://gitlab.example.com', project: 'group/repo' }
      : null),
    meta: { gitlabIssueIid: 42, gitlabUrl: `https://gitlab.example.com/group/repo/-/issues/42?private=${targetMarker}` },
    numberKey: 'gitlabIssueIid',
    urlKey: 'gitlabUrl',
    endpoint: 'https://gitlab.example.com/api/v4/projects/group%2Frepo/issues/42/notes'
  }
] as const;

describe.each(fixtures)('$provider comment receipts', ({ provider, makeWriter, meta, numberKey, urlKey, endpoint }) => {
  let root: string;
  let input: Parameters<OutcomeWriter['postOutcome']>[0];
  let recorder: DeliveryReceiptRecorder;
  const operation = { operation: 'issue_comment', provider, event: 'review_ready' } as const;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'comment-receipts-'));
    recorder = createDeliveryReceiptRecorder(root, spec);
    input = { meta, project: { path: root } as never, event: operation.event, text, settings: {} as never, recorder };
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  });

  it('saves an unconfirmed marker before the one POST and completes it by ID', async () => {
    let markerId: string | undefined;
    fetchMock.mockImplementationOnce(async () => {
      const [marker] = await readDeliveryReceipts(root, spec);
      expect(marker).toMatchObject({ ...operation, status: 'unknown', reason: 'unconfirmed' });
      expect(marker.completedAt).toBeUndefined();
      markerId = marker.id;
      return Response.json({ body: responseBody }, { status: 201 });
    });
    await makeWriter(true).postOutcome(input);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(endpoint, expect.objectContaining({
      method: 'POST', body: JSON.stringify({ body: text })
    }));
    expect(await readDeliveryReceipts(root, spec)).toEqual([
      expect.objectContaining({ ...operation, id: markerId, status: 'delivered', attempts: 1, completedAt: expect.any(String) })
    ]);
  });

  it.each([
    [403, 'failed', 'rejected'], [429, 'failed', 'rate_limited'],
    [408, 'unknown', 'timeout'], [502, 'unknown', 'ambiguous_response']
  ])('classifies HTTP %i as %s/%s without retaining raw data', async (httpStatus, status, reason) => {
    fetchMock.mockResolvedValueOnce(new Response(responseBody, { status: httpStatus }));
    await makeWriter(true).postOutcome(input);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await readDeliveryReceipts(root, spec)).toEqual([
      expect.objectContaining({ ...operation, status, reason, attempts: 1, httpStatus })
    ]);
    const stored = await readFile(path.join(root, '.auto-claude', 'delivery-receipts.json'), 'utf8');
    for (const privateValue of [token, text, responseBody, targetMarker, endpoint]) {
      expect(stored).not.toContain(privateValue);
    }
  });

  it.each([
    ['timeout', new DOMException(responseBody, 'AbortError')],
    ['transport_error', new TypeError(`API error: 429 - ${responseBody}`)],
  ])('records an unconfirmed transport result as unknown/%s', async (reason, error) => {
    fetchMock.mockRejectedValueOnce(error);
    await makeWriter(true).postOutcome(input);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recorder.snapshot()).toEqual([
      expect.objectContaining({ ...operation, status: 'unknown', reason, attempts: 1 })
    ]);
    expect(recorder.snapshot()[0].httpStatus).toBeUndefined();
  });

  it('records an unreadable success response as unknown rather than retrying', async () => {
    fetchMock.mockResolvedValueOnce(new Response(responseBody, { status: 201 }));
    await makeWriter(true).postOutcome(input);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recorder.snapshot()).toEqual([
      expect.objectContaining({ ...operation, status: 'unknown', reason: 'ambiguous_response', attempts: 1 })
    ]);
  });

  it.each([
    [true, { [numberKey]: 0 }, 'invalid_reference'],
    [false, {}, 'missing_configuration'],
    [true, { [urlKey]: 'not a URL' }, 'invalid_reference'],
    [true, { [urlKey]: 'https://other.example.com/group/repo/issues/42' }, 'target_mismatch'],
  ])('skips a blocked comment without sending (%s, %j, %s)', async (configured, changes, reason) => {
    await makeWriter(configured).postOutcome({ ...input, meta: { ...meta, ...changes } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recorder.snapshot()).toEqual([expect.objectContaining({ ...operation, status: 'skipped', reason })]);
    expect(recorder.snapshot()[0].attempts).toBeUndefined();
  });

  it.each([false, true])('still posts exactly once when the recorder fails (after send: %s)', async (afterSend) => {
    fetchMock.mockResolvedValueOnce(Response.json({}, { status: 201 }));
    await makeWriter(true).postOutcome({ ...input, recorder: {
      ...recorder,
      async track(_operation, send) {
        if (afterSend) await send();
        throw new Error('fixture recorder failure');
      }
    } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
