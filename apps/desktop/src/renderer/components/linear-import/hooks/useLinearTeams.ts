/**
 * Hook for loading Linear teams
 */

import { useState, useEffect } from 'react';
import type { LinearTeam, LinearImportErrorCode } from '../types';

export function useLinearTeams(projectId: string, open: boolean) {
  const [teams, setTeams] = useState<LinearTeam[]>([]);
  const [isLoadingTeams, setIsLoadingTeams] = useState(false);
  const [error, setError] = useState<LinearImportErrorCode | null>(null);

  useEffect(() => {
    const loadTeams = async () => {
      if (!open) return;

      setIsLoadingTeams(true);
      setError(null);

      try {
        const result = await window.electronAPI.getLinearTeams(projectId);
        if (result.success && result.data) {
          setTeams(result.data);
        } else {
          setError('loadTeams');
        }
      } catch (err) {
        setError('unknown');
      } finally {
        setIsLoadingTeams(false);
      }
    };

    loadTeams();
  }, [open, projectId]);

  return { teams, isLoadingTeams, error, setError };
}
