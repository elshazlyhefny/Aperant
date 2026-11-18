/**
 * @vitest-environment jsdom
 *
 * Starting or clearing a search must trigger exactly one issues fetch: the
 * handlers only toggle the search flag and the single load effect fetches.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useIssuesStore, useSyncStatusStore } from '../../../../stores/github';
import { useGitHubIssues } from '../useGitHubIssues';

const getGitHubIssues = vi.fn();
const checkGitHubConnection = vi.fn();

beforeEach(() => {
  getGitHubIssues.mockReset();
  checkGitHubConnection.mockReset();
  getGitHubIssues.mockResolvedValue({ success: true, data: { issues: [], hasMore: false } });
  checkGitHubConnection.mockResolvedValue({
    success: true,
    data: { connected: true, repoFullName: 'o/r' },
  });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    getGitHubIssues,
    checkGitHubConnection,
  };
  useIssuesStore.setState({
    issues: [],
    isLoading: false,
    isLoadingMore: false,
    error: null,
    selectedIssueNumber: null,
    filterState: 'open',
    currentPage: 1,
    hasMore: false,
  } as never);
  useSyncStatusStore.setState({ syncStatus: null, connectionError: null } as never);
});

async function mountLoaded() {
  const hook = renderHook(() => useGitHubIssues('p1'));
  await waitFor(() => expect(getGitHubIssues).toHaveBeenCalledTimes(1));
  expect(getGitHubIssues).toHaveBeenLastCalledWith('p1', 'open', null, false);
  return hook;
}

describe('useGitHubIssues load calls', () => {
  it('search start triggers exactly one fetchAll load', async () => {
    const { result } = await mountLoaded();

    await act(async () => {
      result.current.handleSearchStart();
    });
    await waitFor(() => expect(getGitHubIssues).toHaveBeenCalledTimes(2));
    expect(getGitHubIssues.mock.calls[1][3]).toBe(true);

    await act(async () => {
      await Promise.resolve();
    });
    expect(getGitHubIssues).toHaveBeenCalledTimes(2);
  });

  it('search clear triggers exactly one paginated load', async () => {
    const { result } = await mountLoaded();

    await act(async () => {
      result.current.handleSearchStart();
    });
    await waitFor(() => expect(getGitHubIssues).toHaveBeenCalledTimes(2));

    await act(async () => {
      result.current.handleSearchClear();
    });
    await waitFor(() => expect(getGitHubIssues).toHaveBeenCalledTimes(3));
    expect(getGitHubIssues.mock.calls[2][3]).toBe(false);

    await act(async () => {
      await Promise.resolve();
    });
    expect(getGitHubIssues).toHaveBeenCalledTimes(3);
  });

  it('calling search start twice does not load a second time', async () => {
    const { result } = await mountLoaded();

    await act(async () => {
      result.current.handleSearchStart();
    });
    await waitFor(() => expect(getGitHubIssues).toHaveBeenCalledTimes(2));

    await act(async () => {
      result.current.handleSearchStart();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(getGitHubIssues).toHaveBeenCalledTimes(2);
  });

  it('refresh triggers one reload', async () => {
    const { result } = await mountLoaded();

    await act(async () => {
      result.current.handleRefresh();
    });
    await waitFor(() => expect(getGitHubIssues).toHaveBeenCalledTimes(2));
    expect(getGitHubIssues.mock.calls[1][3]).toBe(false);
  });
});
