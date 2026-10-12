import { useCallback, useEffect, useState } from 'react';
import type {
  GitHubTriageApplyResult,
  GitHubTriageConfig,
  GitHubTriageProgress,
  GitHubTriageResult,
} from '../../../../shared/types';

export interface UseGitHubTriageReturn {
  config: GitHubTriageConfig | null;
  results: GitHubTriageResult[];
  isLoading: boolean;
  isRunning: boolean;
  isSaving: boolean;
  isApplying: boolean;
  progress: GitHubTriageProgress | null;
  /** The last run's or load's error, as the main process worded it. */
  error: string | null;
  /** The last label write, so the dialog can show what was and was not applied. */
  applyResult: GitHubTriageApplyResult | null;

  load: () => Promise<void>;
  saveConfig: (config: GitHubTriageConfig) => Promise<boolean>;
  startTriage: (issueNumbers?: number[]) => void;
  applyLabels: (issueNumbers: number[]) => Promise<GitHubTriageApplyResult | null>;
  clearApplyResult: () => void;
}

/**
 * GitHub issue triage: settings, runs (progress and completion arrive as
 * events) and writing the suggested labels to GitHub.
 */
export function useGitHubTriage(projectId: string | undefined): UseGitHubTriageReturn {
  const [config, setConfig] = useState<GitHubTriageConfig | null>(null);
  const [results, setResults] = useState<GitHubTriageResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [progress, setProgress] = useState<GitHubTriageProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<GitHubTriageApplyResult | null>(null);

  const reloadResults = useCallback(async () => {
    if (!projectId) return;
    setResults(await window.electronAPI.github.getTriageResults(projectId));
  }, [projectId]);

  const load = useCallback(async () => {
    if (!projectId) return;
    setIsLoading(true);
    try {
      const [loadedConfig, loadedResults] = await Promise.all([
        window.electronAPI.github.getTriageConfig(projectId),
        window.electronAPI.github.getTriageResults(projectId),
      ]);
      setConfig(loadedConfig);
      setResults(loadedResults);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  // Run events. Every event names its project; another project's run is ignored.
  useEffect(() => {
    if (!projectId) return;
    const cleanupProgress = window.electronAPI.github.onTriageProgress((eventProjectId, update) => {
      if (eventProjectId === projectId) setProgress(update);
    });
    const cleanupComplete = window.electronAPI.github.onTriageComplete((eventProjectId) => {
      if (eventProjectId !== projectId) return;
      setIsRunning(false);
      setError(null);
      // The run saved its results; the stored list also keeps earlier runs.
      void reloadResults();
    });
    const cleanupError = window.electronAPI.github.onTriageError((eventProjectId, payload) => {
      if (eventProjectId !== projectId) return;
      setIsRunning(false);
      setError(payload.error);
    });
    return () => {
      cleanupProgress();
      cleanupComplete();
      cleanupError();
    };
  }, [projectId, reloadResults]);

  const saveConfig = useCallback(
    async (next: GitHubTriageConfig) => {
      if (!projectId) return false;
      setIsSaving(true);
      try {
        const saved = await window.electronAPI.github.saveTriageConfig(projectId, next);
        if (saved) setConfig(next);
        return saved;
      } finally {
        setIsSaving(false);
      }
    },
    [projectId],
  );

  const startTriage = useCallback(
    (issueNumbers?: number[]) => {
      if (!projectId) return;
      setIsRunning(true);
      setError(null);
      setProgress(null);
      setApplyResult(null);
      window.electronAPI.github.runTriage(projectId, issueNumbers);
    },
    [projectId],
  );

  const applyLabels = useCallback(
    async (issueNumbers: number[]) => {
      if (!projectId || issueNumbers.length === 0) return null;
      setIsApplying(true);
      try {
        const outcome = await window.electronAPI.github.applyTriageLabels(projectId, issueNumbers);
        setApplyResult(outcome);
        await reloadResults();
        return outcome;
      } catch (err) {
        const outcome: GitHubTriageApplyResult = {
          success: false,
          error: err instanceof Error ? err.message : String(err),
          applied: [],
          failed: [],
        };
        setApplyResult(outcome);
        return outcome;
      } finally {
        setIsApplying(false);
      }
    },
    [projectId, reloadResults],
  );

  const clearApplyResult = useCallback(() => setApplyResult(null), []);

  return {
    config,
    results,
    isLoading,
    isRunning,
    isSaving,
    isApplying,
    progress,
    error,
    applyResult,
    load,
    saveConfig,
    startTriage,
    applyLabels,
    clearApplyResult,
  };
}
