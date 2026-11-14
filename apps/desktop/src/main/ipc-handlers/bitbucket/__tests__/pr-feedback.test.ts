import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils', async () => {
  const actual = await vi.importActual<typeof import('../utils')>('../utils');
  return { ...actual, bitbucketFetch: vi.fn(), bitbucketFetchLog: vi.fn() };
});

import { bitbucketFetch, bitbucketFetchLog, BitbucketAPIError } from '../utils';
import {
  fetchBitbucketPRFeedback,
  parseBitbucketPullRequestUrl,
  parseBitbucketPRIdFromUrl,
} from '../pr-feedback';
import { PRFeedbackError, MAX_FEEDBACK_ITEMS, MAX_SUMMARY_LENGTH } from '../../github/pr/task-feedback';

const mockFetch = vi.mocked(bitbucketFetch);
const mockLog = vi.mocked(bitbucketFetchLog);
const config = { username: 'u', token: 'tok', repository: 'ws/repo' };
const ITEM_ID_FORMAT = /^(?:check|review_thread|thread|review):[A-Za-z0-9_\-=:.]{1,200}$/;

const pr = {
  id: 7,
  state: 'OPEN',
  source: { branch: { name: 'feat' }, commit: { hash: 'abc123def456' } },
  links: { html: { href: 'https://bitbucket.org/ws/repo/pull-requests/7' } },
};
const pipeline = {
  uuid: '{pipe-uuid}',
  build_number: 42,
  target: { ref_name: 'feat', commit: { hash: 'abc123def456789' } },
};
const step = (n: number, result: string, name = `step ${n}`) => ({
  uuid: `{aaaa-${n}}`,
  name,
  state: { name: 'COMPLETED', result: { name: result } },
});
const comment = (over: Record<string, unknown> = {}) => ({
  id: 1,
  content: { raw: 'fix this' },
  user: { display_name: 'rev' },
  links: { html: { href: 'https://bitbucket.org/c/1' } },
  ...over,
});

function setup(opts: {
  pr?: unknown;
  pipelines?: unknown[];
  steps?: unknown[];
  comments?: unknown[];
  pipelinesError?: unknown;
}) {
  mockFetch.mockImplementation(async (_c: unknown, endpoint: string) => {
    if (endpoint.includes('/steps/')) return { values: opts.steps ?? [] };
    if (endpoint.includes('/pipelines/')) {
      if (opts.pipelinesError) throw opts.pipelinesError;
      return { values: opts.pipelines ?? [pipeline] };
    }
    if (endpoint.includes('/comments')) return { values: opts.comments ?? [] };
    return opts.pr ?? pr;
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mockLog.mockResolvedValue('log');
});

describe('URL parsing', () => {
  it('accepts plain and subpath URLs', () => {
    expect(parseBitbucketPullRequestUrl('https://bitbucket.org/ws/repo/pull-requests/7')).toEqual({
      id: 7,
      workspace: 'ws',
      repoSlug: 'repo',
    });
    expect(parseBitbucketPullRequestUrl('https://bitbucket.org/ws/repo/pull-requests/12/diff')?.id).toBe(12);
    expect(parseBitbucketPRIdFromUrl('https://bitbucket.org/ws/repo/pull-requests/9')).toBe(9);
  });
  it('rejects bad input', () => {
    for (const u of [
      'https://u:p@bitbucket.org/ws/repo/pull-requests/7',
      'https://example.com/ws/repo/pull-requests/7',
      'http://bitbucket.org/ws/repo/pull-requests/7',
      'https://bitbucket.org/ws/repo/pull/7',
      'https://bitbucket.org/ws/repo/pull-requests/0',
      'https://bitbucket.org/ws/repo/pull-requests/9999999999',
      '',
      'nope',
    ]) {
      expect(parseBitbucketPullRequestUrl(u)).toBeNull();
    }
    expect(parseBitbucketPullRequestUrl(`https://bitbucket.org/ws/${'a'.repeat(2100)}/pull-requests/1`)).toBeNull();
    expect(parseBitbucketPRIdFromUrl('nope')).toBeNull();
  });
});

describe('fetchBitbucketPRFeedback pipelines', () => {
  it('returns failed steps with log tails and names; FAILED/ERROR only', async () => {
    setup({
      steps: [
        step(1, 'FAILED', 'Build'),
        step(2, 'ERROR', 'Deploy'),
        step(3, 'SUCCESSFUL'),
        step(4, 'STOPPED'),
        { uuid: '{aaaa-5}', name: 'running', state: { name: 'IN_PROGRESS' } },
      ],
    });
    mockLog.mockResolvedValue('line1\nboom');
    const r = await fetchBitbucketPRFeedback(config, 7);
    expect(r.prState).toBe('open');
    expect(r.headRef).toBe('feat');
    expect(r.headSha).toBe('abc123def456');
    expect(r.reviews).toEqual([]);
    expect(r.checks.map((c) => c.title)).toEqual(['Build', 'Deploy']);
    expect(r.checks[0].summary).toContain('boom');
    expect(r.checks[0].url).toBe('https://bitbucket.org/ws/repo/pipelines/results/42');
    expect(r.checks[0].id).toBe('check:step-42-aaaa-1');
    expect(mockLog.mock.calls[0][2]).toMatchObject({ range: expect.stringMatching(/^bytes=-\d+$/) });
  });

  it('falls back to status when the log fails or is empty', async () => {
    setup({ steps: [step(1, 'FAILED'), step(2, 'ERROR')] });
    mockLog.mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce('  ');
    const r = await fetchBitbucketPRFeedback(config, 7);
    expect(r.checks[0].summary).toBe('Status: FAILED');
    expect(r.checks[1].summary).toBe('Status: ERROR');
  });

  it('redacts secrets and clips long logs to the tail', async () => {
    setup({ steps: [step(1, 'FAILED')] });
    mockLog.mockResolvedValue(`${'x'.repeat(MAX_SUMMARY_LENGTH * 2)}\ntoken ghp_abcdefghijklmnopqrstuvwxyz0123456789 end`);
    const r = await fetchBitbucketPRFeedback(config, 7);
    expect(r.checks[0].summary).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(r.checks[0].summary.endsWith('end')).toBe(true);
    expect(r.checks[0].truncated).toBe(true);
  });

  it('falls back to the branch name when no commit matches', async () => {
    setup({
      pipelines: [{ ...pipeline, target: { ref_name: 'feat', commit: { hash: 'zzz' } } }],
      steps: [step(1, 'FAILED')],
    });
    expect((await fetchBitbucketPRFeedback(config, 7)).checks).toHaveLength(1);
  });

  it('treats no matching pipeline or disabled Pipelines as zero checks', async () => {
    setup({ pipelines: [{ ...pipeline, target: { ref_name: 'other', commit: { hash: 'zzz' } } }] });
    expect((await fetchBitbucketPRFeedback(config, 7)).checks).toEqual([]);
    setup({ pipelinesError: new BitbucketAPIError('nf', 404) });
    expect((await fetchBitbucketPRFeedback(config, 7)).checks).toEqual([]);
  });

  it('caps the number of steps', async () => {
    setup({ steps: Array.from({ length: MAX_FEEDBACK_ITEMS + 10 }, (_, i) => step(i, 'FAILED')) });
    expect((await fetchBitbucketPRFeedback(config, 7)).checks).toHaveLength(MAX_FEEDBACK_ITEMS);
  });
});

describe('fetchBitbucketPRFeedback comments', () => {
  it('keeps unresolved, drops resolved and deleted, handles inline path:line', async () => {
    setup({
      comments: [
        comment({ id: 1 }),
        comment({ id: 2, resolution: { type: 'x' } }),
        comment({ id: 3, deleted: true }),
        comment({ id: 4, inline: { path: 'src/a.ts', from: null, to: 12 } }),
        comment({ id: 5, inline: { path: 'src/b.ts', from: 3, to: null } }),
      ],
    });
    const r = await fetchBitbucketPRFeedback(config, 7);
    expect(r.threads.map((t) => t.id)).toEqual(['thread:1', 'thread:4', 'thread:5']);
    expect(r.threads[0].title).toBe('Review thread');
    expect(r.threads[0].url).toBe('https://bitbucket.org/c/1');
    expect(r.threads[1]).toMatchObject({ title: 'src/a.ts:12', path: 'src/a.ts', line: 12, author: 'rev' });
    expect(r.threads[2].title).toBe('src/b.ts:3');
  });

  it('groups replies under their root and omits resolved roots with replies', async () => {
    setup({
      comments: [
        comment({ id: 1 }),
        comment({ id: 2, parent: { id: 1 }, content: { raw: 'reply' }, user: { display_name: 'bob' } }),
        comment({ id: 3, parent: { id: 2 }, content: { raw: 'nested' } }),
        comment({ id: 4, resolution: {} }),
        comment({ id: 5, parent: { id: 4 } }),
      ],
    });
    const r = await fetchBitbucketPRFeedback(config, 7);
    expect(r.threads).toHaveLength(1);
    expect(r.threads[0].summary).toContain('bob: reply');
    expect(r.threads[0].summary).toContain('nested');
  });

  it('follows next only on the Bitbucket origin', async () => {
    mockFetch.mockImplementation(async (_c: unknown, endpoint: string) => {
      if (endpoint.includes('/steps/') || endpoint.includes('/pipelines/')) return { values: [] };
      if (endpoint.includes('page=2')) return { values: [comment({ id: 2 })] };
      if (endpoint.includes('/comments')) {
        return {
          values: [comment({ id: 1 })],
          next: 'https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/7/comments?page=2',
        };
      }
      return pr;
    });
    expect((await fetchBitbucketPRFeedback(config, 7)).threads).toHaveLength(2);
  });

  it('does not follow a foreign next link', async () => {
    mockFetch.mockImplementation(async (_c: unknown, endpoint: string) => {
      if (endpoint.includes('/pipelines/')) return { values: [] };
      if (endpoint.includes('/comments')) {
        return { values: [comment({ id: 1 })], next: 'https://evil.example/2.0/x?page=2' };
      }
      return pr;
    });
    expect((await fetchBitbucketPRFeedback(config, 7)).threads).toHaveLength(1);
  });

  it('caps thread items', async () => {
    setup({ comments: Array.from({ length: MAX_FEEDBACK_ITEMS + 10 }, (_, i) => comment({ id: i + 1 })) });
    expect((await fetchBitbucketPRFeedback(config, 7)).threads).toHaveLength(MAX_FEEDBACK_ITEMS);
  });
});

describe('state, ids and errors', () => {
  it('maps PR states and builds a fallback url', async () => {
    setup({ pr: { ...pr, state: 'MERGED', links: undefined } });
    const merged = await fetchBitbucketPRFeedback(config, 7);
    expect(merged.prState).toBe('merged');
    expect(merged.prUrl).toBe('https://bitbucket.org/ws/repo/pull-requests/7');
    setup({ pr: { ...pr, state: 'DECLINED' } });
    expect((await fetchBitbucketPRFeedback(config, 7)).prState).toBe('closed');
  });

  it('produces item ids matching the follow-up id format', async () => {
    setup({ steps: [step(1, 'FAILED')], comments: [comment({ id: 11 })] });
    const r = await fetchBitbucketPRFeedback(config, 7);
    for (const item of [...r.checks, ...r.threads]) expect(item.id).toMatch(ITEM_ID_FORMAT);
  });

  it('maps API errors', async () => {
    for (const [status, code] of [
      [404, 'not_found'],
      [401, 'unauthorized'],
      [403, 'forbidden'],
      [500, 'bitbucket_error'],
    ] as const) {
      mockFetch.mockRejectedValue(new BitbucketAPIError('x', status));
      await expect(fetchBitbucketPRFeedback(config, 7)).rejects.toMatchObject({ code });
    }
  });

  it('validates id and repository', async () => {
    await expect(fetchBitbucketPRFeedback(config, 0)).rejects.toBeInstanceOf(PRFeedbackError);
    await expect(fetchBitbucketPRFeedback(config, 1.5)).rejects.toMatchObject({ code: 'not_found' });
    await expect(fetchBitbucketPRFeedback({ ...config, repository: 'bad' }, 7)).rejects.toMatchObject({
      code: 'invalid_repo',
    });
  });
});
