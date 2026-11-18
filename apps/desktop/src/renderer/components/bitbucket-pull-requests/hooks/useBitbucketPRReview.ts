import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BitbucketPRReviewProgress,
  BitbucketPostReviewOptions,
  BitbucketPostReviewResult,
  PRReviewResult
} from '../../../../shared/types';
import type { IPCResult } from '../../../../shared/types/common';
import type { PRLogs, PRLogsKnownVersion, PRLogsUpdatedPayload } from '../../../../preload/api/modules/github-api';
import { applyPRLogsDelta } from '../../github-prs/utils/applyPRLogsDelta';

export type BitbucketReviewStatus = 'idle' | 'reviewing' | 'complete' | 'error';

export interface BitbucketReviewProgress {
  phase: BitbucketPRReviewProgress['phase'];
  progress: number;
  message: string;
}

type Unsubscribe = (() => void) | undefined;

/**
 * zeenha fork: shared with Azure DevOps. Each provider supplies an adapter over its
 * own IPC calls; the default is Bitbucket. Event subscriptions may be absent.
 */
export interface PullRequestReviewApi {
  run: (projectId: string, prId: number) => void;
  cancel: (projectId: string, prId: number) => Promise<boolean>;
  getReview: (projectId: string, prId: number) => Promise<PRReviewResult | null>;
  getLogs: (
    projectId: string,
    prId: number,
    known?: PRLogsKnownVersion
  ) => Promise<PRLogs | null | 'unchanged'>;
  postReview: (
    projectId: string,
    prId: number,
    selectedFindingIds: string[],
    options: BitbucketPostReviewOptions
  ) => Promise<IPCResult<BitbucketPostReviewResult>>;
  onProgress?: (cb: (projectId: string, progress: BitbucketPRReviewProgress) => void) => Unsubscribe;
  onComplete?: (cb: (projectId: string, result: PRReviewResult) => void) => Unsubscribe;
  onError?: (cb: (projectId: string, error: { prId: number; error: string }) => void) => Unsubscribe;
  onLogsUpdated?: (cb: (projectId: string, data: PRLogsUpdatedPayload) => void) => Unsubscribe;
}

/** Default adapter; resolves window.electronAPI at call time. */
export const bitbucketPRReviewApi: PullRequestReviewApi = {
  run: (projectId, prId) => window.electronAPI.runBitbucketPRReview(projectId, prId),
  cancel: (projectId, prId) => window.electronAPI.cancelBitbucketPRReview(projectId, prId),
  getReview: (projectId, prId) => window.electronAPI.getBitbucketPRReview(projectId, prId),
  getLogs: (projectId, prId, known) => window.electronAPI.getBitbucketPRLogs(projectId, prId, known),
  postReview: (projectId, prId, ids, options) =>
    window.electronAPI.postBitbucketPRReview(projectId, prId, ids, options),
  onProgress: (cb) => window.electronAPI.onBitbucketPRReviewProgress?.(cb),
  onComplete: (cb) => window.electronAPI.onBitbucketPRReviewComplete?.(cb),
  onError: (cb) => window.electronAPI.onBitbucketPRReviewError?.(cb),
  onLogsUpdated: (cb) => window.electronAPI.onBitbucketPRLogsUpdated?.(cb)
};

const LOG_POLL_INTERVAL_MS = 1500;

function defaultSelection(result: PRReviewResult | null, posted: Set<string>): Set<string> {
  if (!result?.success) return new Set();
  return new Set(
    result.findings
      .filter((f) => (f.severity === 'critical' || f.severity === 'high') && !posted.has(f.id))
      .map((f) => f.id)
  );
}

export function useBitbucketPRReview(
  projectId: string,
  prId: number | null,
  api: PullRequestReviewApi = bitbucketPRReviewApi
) {
  const [status, setStatus] = useState<BitbucketReviewStatus>('idle');
  const [progress, setProgress] = useState<BitbucketReviewProgress | null>(null);
  const [result, setResult] = useState<PRReviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<PRLogs | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [postedIds, setPostedIds] = useState<Set<string>>(new Set());
  const [isPosting, setIsPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [inlineFailed, setInlineFailed] = useState<Array<{ findingId: string; reason: string }>>([]);

  const logsRef = useRef<PRLogs | null>(null);
  const logsSeqRef = useRef(0);
  const loadSeqRef = useRef(0);
  const postedRef = useRef<Set<string>>(new Set());

  const applyResult = useCallback((review: PRReviewResult | null) => {
    const posted = new Set(review?.postedFindingIds ?? []);
    postedRef.current = posted;
    setPostedIds(posted);
    setResult(review);
    setSelectedIds(defaultSelection(review, posted));
  }, []);

  const setLogsBoth = useCallback((next: PRLogs | null) => {
    logsRef.current = next;
    setLogs(next);
  }, []);

  const refreshLogs = useCallback(async () => {
    if (prId === null) return;
    const seq = ++logsSeqRef.current;
    const current = logsRef.current;
    const known: PRLogsKnownVersion | undefined = current
      ? {
          updated_at: current.updated_at,
          entryCount: Object.values(current.phases).reduce(
            (sum, phase) => sum + (phase?.entries.length ?? 0),
            0
          )
        }
      : undefined;
    const next = await api.getLogs(projectId, prId, known);
    if (seq !== logsSeqRef.current || next === 'unchanged') return;
    setLogsBoth(next);
  }, [api, projectId, prId, setLogsBoth]);

  // Reset and load any saved review when the PR or project changes.
  useEffect(() => {
    const seq = ++loadSeqRef.current;
    logsSeqRef.current++;
    setStatus('idle');
    setProgress(null);
    setError(null);
    setPostError(null);
    setIsPosting(false);
    setLogsBoth(null);
    applyResult(null);
    if (prId === null) return;
    api
      .getReview(projectId, prId)
      .then((saved) => {
        if (seq !== loadSeqRef.current || !saved) return;
        applyResult(saved);
        if (saved.overallStatus === 'in_progress') {
          setStatus('reviewing');
        } else if (saved.success) {
          setStatus('complete');
        } else if (saved.error) {
          setStatus('error');
          setError(saved.error);
        }
      })
      .catch(() => {});
  }, [api, projectId, prId, applyResult, setLogsBoth]);

  // Subscribe to review events, filtered by PR id.
  useEffect(() => {
    if (prId === null) return;
    const cleanups = [
      api.onProgress?.((pid, p) => {
        if (pid !== projectId || p.prId !== prId) return;
        setStatus('reviewing');
        setProgress({ phase: p.phase, progress: p.progress, message: p.message });
      }),
      api.onComplete?.((pid, review) => {
        if (pid !== projectId || review.prNumber !== prId) return;
        applyResult(review);
        setProgress(null);
        setError(null);
        setStatus('complete');
      }),
      api.onError?.((pid, err) => {
        if (pid !== projectId || err.prId !== prId) return;
        setProgress(null);
        setError(err.error);
        setStatus('error');
      }),
      api.onLogsUpdated?.((pid, data) => {
        if (pid !== projectId || data.prNumber !== prId) return;
        if (data.delta) {
          const next = applyPRLogsDelta(logsRef.current, data.delta);
          if (next) {
            logsSeqRef.current++;
            setLogsBoth(next);
            return;
          }
        }
        refreshLogs().catch(() => {});
      })
    ];
    return () => {
      for (const cleanup of cleanups) cleanup?.();
    };
  }, [api, projectId, prId, applyResult, refreshLogs, setLogsBoth]);

  // Poll logs while reviewing; fetch once more when the review finishes.
  useEffect(() => {
    if (status !== 'reviewing') {
      if (status === 'complete' || status === 'error') refreshLogs().catch(() => {});
      return;
    }
    refreshLogs().catch(() => {});
    const timer = setInterval(() => {
      refreshLogs().catch(() => {});
    }, LOG_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [status, refreshLogs]);

  const startReview = useCallback(() => {
    if (prId === null) return;
    setError(null);
    setPostError(null);
    setProgress(null);
    setLogsBoth(null);
    logsSeqRef.current++;
    setStatus('reviewing');
    api.run(projectId, prId);
  }, [api, projectId, prId, setLogsBoth]);

  const cancelReview = useCallback(async () => {
    if (prId === null) return false;
    const cancelled = await api.cancel(projectId, prId);
    if (cancelled) {
      setProgress(null);
      setStatus('idle');
    }
    return cancelled;
  }, [api, projectId, prId]);

  /** Posts the selected findings. Only call after the user confirmed in a dialog. */
  const postSelected = useCallback(
    async ({ postInline }: { postInline: boolean }) => {
      if (prId === null) return false;
      setIsPosting(true);
      setPostError(null);
      setInlineFailed([]);
      try {
        const res = await api.postReview(
          projectId,
          prId,
          Array.from(selectedIds),
          { confirmed: true, postInline }
        );
        if (!res.success) {
          setPostError(res.error || 'Failed to post review');
          return false;
        }
        setInlineFailed(res.data?.inlineFailed ?? []);
        const saved = await api.getReview(projectId, prId);
        if (saved) {
          const posted = new Set(saved.postedFindingIds ?? []);
          postedRef.current = posted;
          setPostedIds(posted);
          setResult(saved);
          setSelectedIds((prev) => new Set(Array.from(prev).filter((id) => !posted.has(id))));
        }
        return true;
      } catch (err) {
        setPostError(err instanceof Error ? err.message : 'Failed to post review');
        return false;
      } finally {
        setIsPosting(false);
      }
    },
    [api, projectId, prId, selectedIds]
  );

  return {
    status,
    progress,
    result,
    error,
    logs,
    selectedIds,
    setSelectedIds,
    postedIds,
    isPosting,
    postError,
    inlineFailed,
    startReview,
    cancelReview,
    postSelected
  };
}
