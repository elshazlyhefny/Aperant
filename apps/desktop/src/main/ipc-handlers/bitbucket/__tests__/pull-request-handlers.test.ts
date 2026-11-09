/**
 * Unit tests for Bitbucket pull request handlers and fetch wrapper
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, app: { getPath: () => '/tmp' } }));

import { transformPullRequest, isValidPullRequestState } from '../pull-request-handlers';
import { bitbucketFetch, bitbucketFetchText, BitbucketAPIError } from '../utils';

const creds = { username: 'alice', token: 'super-secret-token' };

describe('transformPullRequest', () => {
  it('transforms a full payload', () => {
    const pr = transformPullRequest({
      id: 7,
      title: 'Add thing',
      description: 'desc',
      state: 'MERGED',
      source: { branch: { name: 'feat' } },
      destination: { branch: { name: 'main' } },
      author: { display_name: 'Alice', links: { avatar: { href: 'https://a/x.png' } } },
      reviewers: [{ display_name: 'Bob' }],
      comment_count: 3,
      links: { html: { href: 'https://bitbucket.org/ws/repo/pull-requests/7' } },
      created_on: '2024-01-01T00:00:00Z',
      updated_on: '2024-01-02T00:00:00Z'
    });
    expect(pr).toEqual({
      id: 7,
      title: 'Add thing',
      description: 'desc',
      state: 'MERGED',
      sourceBranch: 'feat',
      targetBranch: 'main',
      author: { displayName: 'Alice', avatarUrl: 'https://a/x.png' },
      reviewers: [{ displayName: 'Bob', avatarUrl: undefined }],
      commentCount: 3,
      webUrl: 'https://bitbucket.org/ws/repo/pull-requests/7',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z'
    });
  });

  it('handles sparse payloads', () => {
    const pr = transformPullRequest({ id: 1, author: null, description: null });
    expect(pr.title).toBe('');
    expect(pr.state).toBe('OPEN');
    expect(pr.author).toEqual({ displayName: '', avatarUrl: undefined });
    expect(pr.reviewers).toEqual([]);
    expect(pr.commentCount).toBe(0);
    expect(pr.description).toBeUndefined();
    expect(pr.sourceBranch).toBe('');
    expect(pr.webUrl).toBe('');
    expect(pr.updatedAt).toBe(pr.createdAt);
  });

  it('falls back to OPEN for unknown state', () => {
    expect(transformPullRequest({ id: 1, state: 'WEIRD' }).state).toBe('OPEN');
  });
});

describe('isValidPullRequestState', () => {
  it.each(['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED', 'ALL'])('accepts %s', (s) => {
    expect(isValidPullRequestState(s)).toBe(true);
  });
  it.each(['open', 'closed', '', 'OPEN&x=1'])('rejects %j', (s) => {
    expect(isValidPullRequestState(s)).toBe(false);
  });
});

describe('bitbucketFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('returns JSON and sends Basic auth to the API base', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: 1 }) });
    vi.stubGlobal('fetch', fetchMock);
    const data = await bitbucketFetch(creds, '/repositories/ws/repo');
    expect(data).toEqual({ ok: 1 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.bitbucket.org/2.0/repositories/ws/repo');
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('alice:super-secret-token').toString('base64')}`);
  });

  it('returns text for the diff variant', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => 'diff --git' }));
    expect(await bitbucketFetchText(creds, '/x/diff')).toBe('diff --git');
  });

  it('throws BitbucketAPIError on 401 without leaking the token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 401, statusText: 'Unauthorized', text: async () => 'bad credentials'
    }));
    const err = await bitbucketFetch(creds, '/user').catch((e: unknown) => e as BitbucketAPIError);
    expect(err).toBeInstanceOf(BitbucketAPIError);
    expect(err.statusCode).toBe(401);
    expect(err.message).not.toContain('super-secret-token');
    expect(err.message).not.toContain(Buffer.from('alice:super-secret-token').toString('base64'));
  });

  it('times out via AbortController', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      })
    ));
    const promise = bitbucketFetch(creds, '/slow').catch((e: unknown) => e as BitbucketAPIError);
    await vi.advanceTimersByTimeAsync(30001);
    const err = (await promise) as BitbucketAPIError;
    expect(err).toBeInstanceOf(BitbucketAPIError);
    expect(err.statusCode).toBe(0);
    expect(err.message).toContain('timeout');
  });

  it('refuses absolute endpoints', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(bitbucketFetch(creds, 'https://evil.example.com/x')).rejects.toThrow('relative path');
    await expect(bitbucketFetch(creds, '//evil.example.com/x')).rejects.toThrow('relative path');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
