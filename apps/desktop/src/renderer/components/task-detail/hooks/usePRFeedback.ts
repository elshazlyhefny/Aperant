/**
 * zeenha fork: loads the failing CI checks and review feedback of a task's
 * pull request. Loads only when enabled; never starts a follow-up.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PRFeedbackResult } from '../../../../shared/types';

export function usePRFeedback(taskId: string, enabled: boolean) {
  const [feedback, setFeedback] = useState<PRFeedbackResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const requestId = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.getPRFeedback(taskId);
      if (!mounted.current || id !== requestId.current) return;
      if (result.success && result.data) {
        setFeedback(result.data);
      } else {
        setFeedback(null);
        setError(result.error || 'unknown');
      }
    } catch (err) {
      if (!mounted.current || id !== requestId.current) return;
      setFeedback(null);
      setError(err instanceof Error ? err.message : 'unknown');
    } finally {
      if (mounted.current && id === requestId.current) setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  return { feedback, loading, error, refresh };
}
