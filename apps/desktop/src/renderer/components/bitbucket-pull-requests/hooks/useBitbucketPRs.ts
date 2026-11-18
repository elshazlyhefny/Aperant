import { useCallback, useEffect, useRef, useState } from 'react';
import type { BitbucketPullRequest } from '../../../../shared/types';
import type { IPCResult } from '../../../../shared/types/common';

export type BitbucketStateFilter = 'OPEN' | 'MERGED' | 'DECLINED' | 'ALL';

/** Error string returned by the main process when credentials/repo are missing. */
export const BITBUCKET_NOT_CONFIGURED_ERROR = 'Bitbucket not configured';

/**
 * zeenha fork: the Bitbucket PR components and hooks are shared with Azure DevOps.
 * Each provider passes an adapter over its own IPC calls; the default is Bitbucket.
 */
export interface PullRequestListApi {
  listPullRequests: (projectId: string, state?: string) => Promise<IPCResult<BitbucketPullRequest[]>>;
  getPullRequest: (projectId: string, prId: number) => Promise<IPCResult<BitbucketPullRequest>>;
  getDiff: (projectId: string, prId: number) => Promise<IPCResult<string>>;
  postComment: (projectId: string, prId: number, body: string) => Promise<IPCResult<{ id: number }>>;
  /** Error string the provider returns when not configured; defaults to the Bitbucket one. */
  notConfiguredError?: string;
}

/** Default adapter; resolves window.electronAPI at call time. */
export const bitbucketPRApi: PullRequestListApi = {
  listPullRequests: (projectId, state) => window.electronAPI.getBitbucketPullRequests(projectId, state),
  getPullRequest: (projectId, prId) => window.electronAPI.getBitbucketPullRequest(projectId, prId),
  getDiff: (projectId, prId) => window.electronAPI.getBitbucketPullRequestDiff(projectId, prId),
  postComment: (projectId, prId, body) =>
    window.electronAPI.postBitbucketPullRequestComment(projectId, prId, body)
};

interface UseBitbucketPRsOptions {
  stateFilter?: BitbucketStateFilter;
  api?: PullRequestListApi;
}

export function useBitbucketPRs(projectId: string, options: UseBitbucketPRsOptions = {}) {
  const { stateFilter = 'OPEN', api = bitbucketPRApi } = options;
  const [pullRequests, setPullRequests] = useState<BitbucketPullRequest[]>([]);
  const [selectedPRId, setSelectedPRId] = useState<number | null>(null);
  const [selectedPR, setSelectedPR] = useState<BitbucketPullRequest | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Monotonic request ids guard against stale responses.
  const listRequestRef = useRef(0);
  const detailRequestRef = useRef(0);

  const loadList = useCallback(async () => {
    const requestId = ++listRequestRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const result = await api.listPullRequests(projectId, stateFilter);
      if (requestId !== listRequestRef.current) return;
      if (result.success && result.data) {
        setPullRequests(result.data);
      } else {
        setPullRequests([]);
        setError(result.error || 'Failed to load pull requests');
      }
    } catch (err) {
      if (requestId !== listRequestRef.current) return;
      setPullRequests([]);
      setError(err instanceof Error ? err.message : 'Failed to load pull requests');
    } finally {
      if (requestId === listRequestRef.current) setIsLoading(false);
    }
  }, [api, projectId, stateFilter]);

  const loadDetail = useCallback(
    async (prId: number) => {
      const requestId = ++detailRequestRef.current;
      setIsLoadingDetail(true);
      setDetailError(null);
      try {
        const [prResult, diffResult] = await Promise.all([
          api.getPullRequest(projectId, prId),
          api.getDiff(projectId, prId)
        ]);
        if (requestId !== detailRequestRef.current) return;
        if (prResult.success && prResult.data) {
          setSelectedPR(prResult.data);
          setDiff(diffResult.success ? (diffResult.data ?? '') : null);
          if (!diffResult.success) setDetailError(diffResult.error || null);
        } else {
          setSelectedPR(null);
          setDiff(null);
          setDetailError(prResult.error || 'Failed to load pull request');
        }
      } catch (err) {
        if (requestId !== detailRequestRef.current) return;
        setSelectedPR(null);
        setDiff(null);
        setDetailError(err instanceof Error ? err.message : 'Failed to load pull request');
      } finally {
        if (requestId === detailRequestRef.current) setIsLoadingDetail(false);
      }
    },
    [api, projectId]
  );

  // Reset selection when the project changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: projectId is the trigger
  useEffect(() => {
    detailRequestRef.current++;
    setSelectedPRId(null);
    setSelectedPR(null);
    setDiff(null);
    setDetailError(null);
    setIsLoadingDetail(false);
  }, [projectId]);

  useEffect(() => {
    void loadList();
    return () => {
      // Invalidate any in-flight list request when inputs change or on unmount.
      listRequestRef.current++;
    };
  }, [loadList]);

  const selectPR = useCallback(
    (prId: number) => {
      setSelectedPRId(prId);
      void loadDetail(prId);
    },
    [loadDetail]
  );

  const refresh = useCallback(async () => {
    await loadList();
    if (selectedPRId !== null) await loadDetail(selectedPRId);
  }, [loadList, loadDetail, selectedPRId]);

  const postComment = useCallback(
    async (prId: number, body: string): Promise<boolean> => {
      try {
        const result = await api.postComment(projectId, prId, body);
        if (!result.success) {
          setDetailError(result.error || 'Failed to post comment');
          return false;
        }
        await loadList();
        await loadDetail(prId);
        return true;
      } catch (err) {
        setDetailError(err instanceof Error ? err.message : 'Failed to post comment');
        return false;
      }
    },
    [api, projectId, loadList, loadDetail]
  );

  return {
    pullRequests,
    isLoading,
    isLoadingDetail,
    error,
    detailError,
    notConfigured: error === (api.notConfiguredError ?? BITBUCKET_NOT_CONFIGURED_ERROR),
    selectedPR,
    selectedPRId,
    diff,
    selectPR,
    refresh,
    postComment
  };
}
