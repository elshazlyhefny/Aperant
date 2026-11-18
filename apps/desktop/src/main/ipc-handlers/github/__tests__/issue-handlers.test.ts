/**
 * zeenha fork: cursor-based pagination of the GitHub issues list.
 *
 * GitHub is mocked at githubFetch, so the requested URLs show exactly which
 * API pages each call downloads.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../../shared/constants';

type Fn = (...args: unknown[]) => Promise<unknown>;
const handlers = vi.hoisted(() => new Map<string, Fn>());
const mockGithubFetch = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  project: { id: 'p1' } as null | { id: string },
  config: { token: 'tok', repo: 'o/r' } as null | { token: string; repo: string },
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: Fn) => handlers.set(channel, fn) },
}));
vi.mock('../utils', () => ({
  getGitHubConfig: () => state.config,
  githubFetch: (...args: unknown[]) => mockGithubFetch(...args),
  normalizeRepoReference: (repo: string) => repo,
}));
vi.mock('../../../project-store', () => ({
  projectStore: { getProject: () => state.project },
}));
vi.mock('../../../../shared/utils/debug-logger', () => ({ debugLog: vi.fn() }));

import { registerGetIssues } from '../issue-handlers';

registerGetIssues();

interface Result {
  success: boolean;
  error?: string;
  data?: {
    issues: Array<{ number: number }>;
    hasMore: boolean;
    nextCursor: { apiPage: number; offset: number } | null;
  };
}

const getIssues = (cursor?: unknown, fetchAll = false) => {
  const fn = handlers.get(IPC_CHANNELS.GITHUB_GET_ISSUES);
  if (!fn) throw new Error('no handler');
  return fn({}, 'p1', 'open', cursor, fetchAll) as Promise<Result>;
};

// Raw item number = (apiPage - 1) * 100 + index + 1
function makeItem(apiPage: number, index: number, isPr = false) {
  const number = (apiPage - 1) * 100 + index + 1;
  return {
    id: number,
    number,
    title: `t${number}`,
    body: '',
    state: 'open',
    labels: [],
    assignees: [],
    user: { login: 'u', avatar_url: '' },
    milestone: null,
    created_at: '',
    updated_at: '',
    closed_at: null,
    comments: 0,
    url: '',
    html_url: '',
    ...(isPr ? { pull_request: {} } : {}),
  };
}
const makePage = (apiPage: number, count = 100, isPr: (i: number) => boolean = () => false) =>
  Array.from({ length: count }, (_, i) => makeItem(apiPage, i, isPr(i)));

const pagesRequested = () =>
  mockGithubFetch.mock.calls.map((c) => Number(/&page=(\d+)/.exec(c[1] as string)?.[1]));

/** Serve full issue pages for every API page. */
const serveFullPages = () =>
  mockGithubFetch.mockImplementation(async (_t: string, url: string) =>
    makePage(Number(/&page=(\d+)/.exec(url)?.[1]))
  );

beforeEach(() => {
  mockGithubFetch.mockReset();
  state.project = { id: 'p1' };
  state.config = { token: 'tok', repo: 'o/r' };
});

describe('GITHUB_GET_ISSUES cursor pagination', () => {
  it('first call reads only page 1 and returns 50 issues with a mid-page cursor', async () => {
    serveFullPages();
    const res = await getIssues();
    expect(pagesRequested()).toEqual([1]);
    expect(res.data?.issues).toHaveLength(50);
    expect(res.data?.issues[0].number).toBe(1);
    expect(res.data?.hasMore).toBe(true);
    expect(res.data?.nextCursor).toEqual({ apiPage: 1, offset: 50 });
  });

  it('second call resumes at items 50-99 with one request', async () => {
    serveFullPages();
    const res = await getIssues({ apiPage: 1, offset: 50 });
    expect(pagesRequested()).toEqual([1]);
    expect(res.data?.issues).toHaveLength(50);
    expect(res.data?.issues[0].number).toBe(51);
    expect(res.data?.nextCursor).toEqual({ apiPage: 2, offset: 0 });
    expect(res.data?.hasMore).toBe(true);
  });

  it('a cursor at apiPage 3 never fetches pages 1-2', async () => {
    serveFullPages();
    await getIssues({ apiPage: 3, offset: 0 });
    expect(pagesRequested()).toEqual([3]);
  });

  it('filters PRs and counts raw items in the cursor offset', async () => {
    // Every other item is a PR: the 50th issue is raw index 98 => offset 99.
    mockGithubFetch.mockResolvedValue(makePage(1, 100, (i) => i % 2 === 1));
    const res = await getIssues();
    expect(res.data?.issues).toHaveLength(50);
    expect(res.data?.issues.every((i) => i.number % 2 === 1)).toBe(true);
    expect(res.data?.nextCursor).toEqual({ apiPage: 1, offset: 99 });

    // First 30 raw items are PRs: 50 issues end at raw index 79 => offset 80.
    mockGithubFetch.mockReset();
    mockGithubFetch.mockResolvedValue(makePage(1, 100, (i) => i < 30));
    const res2 = await getIssues();
    expect(res2.data?.issues).toHaveLength(50);
    expect(res2.data?.nextCursor).toEqual({ apiPage: 1, offset: 80 });
  });

  it('deep scrolling beyond 5 API pages in total works across calls', async () => {
    serveFullPages();
    const res = await getIssues({ apiPage: 6, offset: 0 });
    expect(pagesRequested()).toEqual([6]);
    expect(res.data?.issues).toHaveLength(50);
    expect(res.data?.hasMore).toBe(true);
    expect(res.data?.nextCursor).toEqual({ apiPage: 6, offset: 50 });
  });

  it('per-request cap: 5 all-PR pages return nothing but advance the cursor', async () => {
    mockGithubFetch.mockImplementation(async (_t: string, url: string) =>
      makePage(Number(/&page=(\d+)/.exec(url)?.[1]), 100, () => true)
    );
    const res = await getIssues();
    expect(pagesRequested()).toEqual([1, 2, 3, 4, 5]);
    expect(res.data?.issues).toHaveLength(0);
    expect(res.data?.hasMore).toBe(true);
    expect(res.data?.nextCursor?.apiPage).toBe(6);
  });

  it('end of repo: a short page yields hasMore false', async () => {
    mockGithubFetch.mockResolvedValue(makePage(1, 30));
    const res = await getIssues();
    expect(res.data?.issues).toHaveLength(30);
    expect(res.data?.hasMore).toBe(false);
    expect(res.data?.nextCursor).toBeNull();
  });

  it('end of repo: an empty page yields hasMore false', async () => {
    mockGithubFetch.mockResolvedValue([]);
    const res = await getIssues({ apiPage: 2, offset: 0 });
    expect(res.data?.issues).toHaveLength(0);
    expect(res.data?.hasMore).toBe(false);
    expect(res.data?.nextCursor).toBeNull();
  });

  it('end of repo: consuming the last items of a short page yields null cursor', async () => {
    mockGithubFetch.mockResolvedValue(makePage(1, 70));
    const res = await getIssues({ apiPage: 1, offset: 20 });
    expect(res.data?.issues).toHaveLength(50);
    expect(res.data?.nextCursor).toBeNull();
    expect(res.data?.hasMore).toBe(false);
  });

  it.each([
    { apiPage: 0, offset: 0 },
    { apiPage: -1, offset: 0 },
    { apiPage: 1.5, offset: 0 },
    { apiPage: 2, offset: -5 },
    { apiPage: 'x', offset: 0 },
    { apiPage: 1 },
    'garbage',
  ])('invalid cursor %j falls back to the start', async (cursor) => {
    serveFullPages();
    const res = await getIssues(cursor);
    expect(pagesRequested()).toEqual([1]);
    expect(res.data?.issues[0].number).toBe(1);
  });

  it('fetchAll fetches every page and reports no more', async () => {
    mockGithubFetch.mockImplementation(async (_t: string, url: string) => {
      const p = Number(/&page=(\d+)/.exec(url)?.[1]);
      return p < 3 ? makePage(p) : makePage(p, 20);
    });
    const res = await getIssues(undefined, true);
    expect(pagesRequested()).toEqual([1, 2, 3]);
    expect(res.data?.issues).toHaveLength(220);
    expect(res.data?.hasMore).toBe(false);
    expect(res.data?.nextCursor).toBeNull();
  });

  it('returns the unchanged errors for a missing project or config', async () => {
    state.project = null;
    expect(await getIssues()).toEqual({ success: false, error: 'Project not found' });
    state.project = { id: 'p1' };
    state.config = null;
    expect(await getIssues()).toEqual({
      success: false,
      error: 'No GitHub token or repository configured',
    });
    expect(mockGithubFetch).not.toHaveBeenCalled();
  });
});
