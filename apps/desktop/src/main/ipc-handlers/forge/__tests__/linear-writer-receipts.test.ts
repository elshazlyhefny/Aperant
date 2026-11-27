/** zeenha fork: exercise the real Linear client and persisted receipts with mocked HTTP. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeliveryReceiptRecorder, readDeliveryReceipts } from '../../../delivery-receipts';
import { linearWriter } from '../linear-writer';
import type { OutcomeWriter } from '../types';

const specId = '001-linear';
const token = 'fixture-linear-private-key';
const text = 'fixture-comment-private';
const body = 'fixture-graphql-diagnostic-private';
const fetchMock = vi.fn<typeof fetch>();
const comment = (success: unknown) => Response.json({ data: { commentCreate: { success } } });
const update = (success: unknown) => Response.json({ data: { issueUpdate: { success } } });
const states = (nodes: unknown) => Response.json({ data: { issue: { team: { states: { nodes } } } } });
const matchingState = { id: 'st-2', name: 'In Review' };

let root: string;
let input: Parameters<OutcomeWriter['postOutcome']>[0];
const receipts = async () =>
  (await readDeliveryReceipts(root, specId)).sort((a, b) => b.operation.localeCompare(a.operation));

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'linear-receipts-'));
  await writeFile(path.join(root, '.env'), `LINEAR_API_KEY=${token}\n`);
  input = {
    meta: { linearIssueId: 'abc-123' }, project: { path: root, autoBuildPath: '.' } as never,
    event: 'review_ready', text,
    settings: { linearTransitionOnReview: true, linearTransitionStateName: ' in review ' } as never,
    recorder: createDeliveryReceiptRecorder(root, specId)
  };
  vi.stubGlobal('fetch', fetchMock.mockReset());
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

describe('Linear receipts', () => {
  it('records typed comment rejection and still transitions exactly once after one lookup', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ errors: [{ message: body }] }, { status: 429 }))
      .mockResolvedValueOnce(states([matchingState]))
      .mockResolvedValueOnce(update(true));
    await linearWriter.postOutcome(input);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const requests = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(requests.map(({ query }) => query)).toEqual([
      expect.stringContaining('commentCreate'), expect.stringContaining('states'), expect.stringContaining('issueUpdate')
    ]);
    expect(requests[2].variables).toEqual({ id: 'abc-123', input: { stateId: 'st-2' } });
    expect(await receipts()).toEqual([
      expect.objectContaining({ operation: 'issue_transition', provider: 'linear', status: 'delivered', attempts: 1 }),
      expect.objectContaining({ operation: 'issue_comment', provider: 'linear', status: 'failed', reason: 'rate_limited', httpStatus: 429, attempts: 1 })
    ]);
    const stored = await readFile(path.join(root, '.auto-claude', 'delivery-receipts.json'), 'utf8');
    for (const value of [token, text, body, 'abc-123', 'st-2']) expect(stored).not.toContain(value);
  });

  it.each([
    [false, 'failed', 'rejected'], [undefined, 'unknown', 'ambiguous_response'], ['true', 'unknown', 'ambiguous_response']
  ])('requires boolean acknowledgment (%s) for both mutations', async (success, status, reason) => {
    fetchMock.mockResolvedValueOnce(comment(success)).mockResolvedValueOnce(states([matchingState]))
      .mockResolvedValueOnce(update(success));
    await linearWriter.postOutcome(input);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await receipts()).toEqual([
      expect.objectContaining({ operation: 'issue_transition', status, reason, attempts: 1 }),
      expect.objectContaining({ operation: 'issue_comment', status, reason, attempts: 1 })
    ]);
  });

  it.each([
    ['skipped', 'state_unavailable', () => states([{ ...matchingState, name: 'Done' }])],
    ['failed', 'lookup_failed', () => states(undefined)],
    ['failed', 'lookup_failed', () => new Response(body, { status: 503 })]
  ])('reports a %s lookup without attempting a mutation (%s)', async (status, reason, lookupResponse) => {
    fetchMock.mockResolvedValueOnce(comment(true)).mockResolvedValueOnce(lookupResponse());
    await linearWriter.postOutcome(input);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const rows = await receipts();
    expect(rows).toEqual([
      expect.objectContaining({ operation: 'issue_transition', status, reason }),
      expect.objectContaining({ operation: 'issue_comment', status: 'delivered' })
    ]);
    expect(rows[0].attempts).toBeUndefined();
  });

  it('keeps a mutation timeout unknown, unlike a failed lookup', async () => {
    fetchMock.mockResolvedValueOnce(comment(true)).mockResolvedValueOnce(states([matchingState]))
      .mockRejectedValueOnce(new DOMException(body, 'TimeoutError'));
    await linearWriter.postOutcome(input);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await receipts()).toEqual([
      expect.objectContaining({ operation: 'issue_transition', status: 'unknown', reason: 'timeout', attempts: 1 }),
      expect.objectContaining({ operation: 'issue_comment', status: 'delivered' })
    ]);
  });

  it('records skips for enabled operations on invalid reference', async () => {
    await linearWriter.postOutcome({ ...input, meta: { linearIssueId: '/' } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await receipts()).toEqual([
      expect.objectContaining({ operation: 'issue_transition', status: 'skipped', reason: 'invalid_reference' }),
      expect.objectContaining({ operation: 'issue_comment', status: 'skipped', reason: 'invalid_reference' })
    ]);
  });

  it('does not look up or record transitions on non-review outcomes', async () => {
    fetchMock.mockResolvedValueOnce(comment(true));
    await linearWriter.postOutcome({ ...input, event: 'blocked' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await receipts()).toEqual([expect.objectContaining({ operation: 'issue_comment', status: 'delivered' })]);
  });
});
