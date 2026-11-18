import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { GitHubIssue } from '../../../shared/types';
import {
  useIssuesStore,
  loadGitHubIssues,
  loadMoreGitHubIssues
} from '../github/issues-store';

const getGitHubIssues = vi.fn();

function issue(number: number): GitHubIssue {
  return { number, title: `Issue ${number}`, state: 'open' } as unknown as GitHubIssue;
}

function ok(numbers: number[], hasMore: boolean, nextCursor: { apiPage: number; offset: number } | null) {
  return { success: true, data: { issues: numbers.map(issue), hasMore, nextCursor } };
}

const state = () => useIssuesStore.getState();

describe('github issues-store cursor pagination', () => {
  beforeEach(() => {
    getGitHubIssues.mockReset();
    (globalThis as unknown as { window: Record<string, unknown> }).window =
      (globalThis as unknown as { window?: Record<string, unknown> }).window ?? {};
    (window as unknown as { electronAPI: unknown }).electronAPI = { getGitHubIssues };
    useIssuesStore.setState({
      issues: [],
      isLoading: false,
      isLoadingMore: false,
      error: null,
      selectedIssueNumber: null,
      filterState: 'open',
      nextCursor: null,
      hasMore: true
    });
  });

  it('initial load stores the cursor and calls the API with a null cursor', async () => {
    getGitHubIssues.mockResolvedValueOnce(ok([1, 2], true, { apiPage: 1, offset: 2 }));
    await loadGitHubIssues('p1', 'open');

    expect(getGitHubIssues).toHaveBeenCalledWith('p1', 'open', null, false);
    expect(state().issues.map(i => i.number)).toEqual([1, 2]);
    expect(state().hasMore).toBe(true);
    expect(state().nextCursor).toEqual({ apiPage: 1, offset: 2 });
  });

  it('loadMore passes the stored cursor, appends and stores the new cursor', async () => {
    getGitHubIssues.mockResolvedValueOnce(ok([1], true, { apiPage: 1, offset: 1 }));
    await loadGitHubIssues('p1', 'open');
    getGitHubIssues.mockResolvedValueOnce(ok([2], true, { apiPage: 1, offset: 2 }));
    await loadMoreGitHubIssues('p1', 'open');

    expect(getGitHubIssues).toHaveBeenLastCalledWith('p1', 'open', { apiPage: 1, offset: 1 }, false);
    expect(state().issues.map(i => i.number)).toEqual([1, 2]);
    expect(state().nextCursor).toEqual({ apiPage: 1, offset: 2 });
  });

  it('consecutive loadMores chain cursors', async () => {
    useIssuesStore.setState({ nextCursor: { apiPage: 1, offset: 5 }, hasMore: true });
    getGitHubIssues.mockResolvedValueOnce(ok([1], true, { apiPage: 2, offset: 0 }));
    getGitHubIssues.mockResolvedValueOnce(ok([2], false, null));

    await loadMoreGitHubIssues('p1', 'open');
    await loadMoreGitHubIssues('p1', 'open');

    expect(getGitHubIssues).toHaveBeenNthCalledWith(1, 'p1', 'open', { apiPage: 1, offset: 5 }, false);
    expect(getGitHubIssues).toHaveBeenNthCalledWith(2, 'p1', 'open', { apiPage: 2, offset: 0 }, false);
    expect(state().hasMore).toBe(false);
    expect(state().nextCursor).toBeNull();
  });

  it('loadMore is a no-op when cursor is null', async () => {
    useIssuesStore.setState({ nextCursor: null, hasMore: true });
    await loadMoreGitHubIssues('p1', 'open');
    expect(getGitHubIssues).not.toHaveBeenCalled();
  });

  it('loadMore is a no-op when hasMore is false', async () => {
    useIssuesStore.setState({ nextCursor: { apiPage: 2, offset: 0 }, hasMore: false });
    await loadMoreGitHubIssues('p1', 'open');
    expect(getGitHubIssues).not.toHaveBeenCalled();
  });

  it('loadMore is a no-op while loading', async () => {
    useIssuesStore.setState({ nextCursor: { apiPage: 2, offset: 0 }, hasMore: true, isLoadingMore: true });
    await loadMoreGitHubIssues('p1', 'open');
    useIssuesStore.setState({ isLoadingMore: false, isLoading: true });
    await loadMoreGitHubIssues('p1', 'open');
    expect(getGitHubIssues).not.toHaveBeenCalled();
  });

  it('treats hasMore without a cursor as no more results', async () => {
    useIssuesStore.setState({ nextCursor: { apiPage: 1, offset: 1 }, hasMore: true });
    getGitHubIssues.mockResolvedValueOnce(ok([3], true, null));
    await loadMoreGitHubIssues('p1', 'open');
    expect(state().hasMore).toBe(false);
    expect(state().nextCursor).toBeNull();
  });

  it('resetPagination and clearIssues reset nextCursor to null', () => {
    useIssuesStore.setState({ nextCursor: { apiPage: 3, offset: 4 }, hasMore: false });
    state().resetPagination();
    expect(state().nextCursor).toBeNull();
    expect(state().hasMore).toBe(true);

    useIssuesStore.setState({ nextCursor: { apiPage: 3, offset: 4 } });
    state().clearIssues();
    expect(state().nextCursor).toBeNull();
  });

  it('fetchAll load sets hasMore false and no cursor', async () => {
    getGitHubIssues.mockResolvedValueOnce(ok([1, 2, 3], false, null));
    await loadGitHubIssues('p1', 'open', true);

    expect(getGitHubIssues).toHaveBeenCalledWith('p1', 'open', null, true);
    expect(state().hasMore).toBe(false);
    expect(state().nextCursor).toBeNull();
  });

  it('discards results when filterState changes mid-request', async () => {
    const cursor = { apiPage: 1, offset: 1 };
    useIssuesStore.setState({ nextCursor: cursor, hasMore: true, issues: [issue(1)] });
    getGitHubIssues.mockImplementationOnce(async () => {
      useIssuesStore.setState({ filterState: 'closed' });
      return ok([2], true, { apiPage: 1, offset: 2 });
    });
    await loadMoreGitHubIssues('p1', 'open');

    expect(state().issues.map(i => i.number)).toEqual([1]);
    expect(state().nextCursor).toEqual(cursor);
    expect(state().isLoadingMore).toBe(false);
  });

  it('error results call setError and keep the old cursor', async () => {
    const cursor = { apiPage: 1, offset: 1 };
    useIssuesStore.setState({ nextCursor: cursor, hasMore: true });
    getGitHubIssues.mockResolvedValueOnce({ success: false, error: 'boom' });
    await loadMoreGitHubIssues('p1', 'open');

    expect(state().error).toBe('boom');
    expect(state().nextCursor).toEqual(cursor);
    expect(state().isLoadingMore).toBe(false);
  });
});
