/**
 * Hook for loading Linear issues for a selected team/project
 */

import { useState, useEffect, useRef } from 'react';
import type { LinearIssue, LinearImportErrorCode } from '../types';

export function useLinearIssues(
  projectId: string,
  selectedTeamId: string,
  selectedProjectId: string,
  onIssuesChange?: () => void
) {
  const [issues, setIssues] = useState<LinearIssue[]>([]);
  const [isLoadingIssues, setIsLoadingIssues] = useState(false);
  const [error, setError] = useState<LinearImportErrorCode | null>(null);

  // Use ref to store the callback to avoid unnecessary re-renders
  const onIssuesChangeRef = useRef(onIssuesChange);
  onIssuesChangeRef.current = onIssuesChange;

  useEffect(() => {
    const loadIssues = async () => {
      if (!selectedTeamId) {
        setIssues([]);
        return;
      }

      setIsLoadingIssues(true);
      setError(null);

      try {
        const result = await window.electronAPI.getLinearIssues(
          projectId,
          selectedTeamId,
          selectedProjectId || undefined
        );
        if (result.success && result.data) {
          setIssues(result.data);
          onIssuesChangeRef.current?.();
        } else {
          setError('loadIssues');
        }
      } catch (err) {
        setError('unknown');
      } finally {
        setIsLoadingIssues(false);
      }
    };

    loadIssues();
  }, [projectId, selectedTeamId, selectedProjectId]);

  return { issues, isLoadingIssues, error, setError };
}
