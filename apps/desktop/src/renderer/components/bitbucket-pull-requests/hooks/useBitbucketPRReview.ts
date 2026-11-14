import { useCallback, useEffect, useRef, useState } from 'react';
import type { BitbucketPRReviewProgress, PRReviewResult } from '../../../../shared/types';
import type { PRLogs, PRLogsKnownVersion } from '../../../../preload/api/modules/github-api';
import { applyPRLogsDelta } from '../../github-prs/utils/applyPRLogsDelta';

export type BitbucketReviewStatus = 'idle' | 'reviewing' | 'complete' | 'error';

export interface BitbucketReviewProgress {
  phase: BitbucketPRReviewProgress['phase'];
  progress: number;
  message: string;
}

const LOG_POLL_INTERVAL_MS = 1500;

function defaultSelection(result: PRReviewResult | null, posted: Set<string>): Set<string> {
  if (!result?.success) return new Set();
  return new Set(
    result.findings
      .filter((f) => (f.severity === 'critical' || f.severity === 'high') && !posted.has(f.id))
      .map((f) => f.id)
  );
}

export function useBitbucketPRReview(projectId: string, prId: number | null) {
  const [status, setStatus] = useState<BitbucketReviewStatus>('idle');
  const [progress, setProgress] = useState<BitbucketReviewProgress | null>(null);
  const [result, setResult] = useState<PRReviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<PRLogs | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [postedIds, setPostedIds] = useState<Set<string>>(new Set());
  const [isPosting, setIsPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

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
    const next = await window.electronAPI.getBitbucketPRLogs(projectId, prId, known);
    if (seq !== logsSeqRef.current || next === 'unchanged') return;
    setLogsBoth(next);
  }, [projectId, prId, setLogsBoth]);

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
    window.electronAPI
      .getBitbucketPRReview(projectId, prId)
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
  }, [projectId, prId, applyResult, setLogsBoth]);

  // Subscribe to review events, filtered by PR id.
  useEffect(() => {
    if (prId === null) return;
    const api = window.electronAPI;
    const cleanups = [
      api.onBitbucketPRReviewProgress?.((pid, p) => {
        if (pid !== projectId || p.prId !== prId) return;
        setStatus('reviewing');
        setProgress({ phase: p.phase, progress: p.progress, message: p.message });
      }),
      api.onBitbucketPRReviewComplete?.((pid, review) => {
        if (pid !== projectId || review.prNumber !== prId) return;
        applyResult(review);
        setProgress(null);
        setError(null);
        setStatus('complete');
      }),
      api.onBitbucketPRReviewError?.((pid, err) => {
        if (pid !== projectId || err.prId !== prId) return;
        setProgress(null);
        setError(err.error);
        setStatus('error');
      }),
      api.onBitbucketPRLogsUpdated?.((pid, data) => {
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
  }, [projectId, prId, applyResult, refreshLogs, setLogsBoth]);

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
    window.electronAPI.runBitbucketPRReview(projectId, prId);
  }, [projectId, prId, setLogsBoth]);

  const cancelReview = useCallback(async () => {
    if (prId === null) return false;
    const cancelled = await window.electronAPI.cancelBitbucketPRReview(projectId, prId);
    if (cancelled) {
      setProgress(null);
      setStatus('idle');
    }
    return cancelled;
  }, [projectId, prId]);

  /** Posts the selected findings. Only call after the user confirmed in a dialog. */
  const postSelected = useCallback(
    async ({ postInline }: { postInline: boolean }) => {
      if (prId === null) return false;
      setIsPosting(true);
      setPostError(null);
      try {
        const res = await window.electronAPI.postBitbucketPRReview(
          projectId,
          prId,
          Array.from(selectedIds),
          { confirmed: true, postInline }
        );
        if (!res.success) {
          setPostError(res.error || 'Failed to post review');
          return false;
        }
        const saved = await window.electronAPI.getBitbucketPRReview(projectId, prId);
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
    [projectId, prId, selectedIds]
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
    startReview,
    cancelReview,
    postSelected
  };
}
