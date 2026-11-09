/**
 * State and IPC calls for the Jira import modal.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { JiraImportResult, JiraIssue, JiraProject } from '../../../shared/types';

const SEARCH_DEBOUNCE_MS = 300;

export interface UseJiraImportProps {
  projectId: string;
  open: boolean;
  /** Default Jira project key (from the project's jiraProjectKey setting) */
  defaultProjectKey?: string;
  onImportComplete?: (result: JiraImportResult) => void;
}

export function useJiraImport({
  projectId,
  open,
  defaultProjectKey,
  onImportComplete
}: UseJiraImportProps) {
  const { t } = useTranslation('jira');

  const [jiraProjects, setJiraProjects] = useState<JiraProject[]>([]);
  const [projectOverride, setProjectOverride] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [searchText, setSearchText] = useState('');
  const [issues, setIssues] = useState<JiraIssue[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | undefined>();
  const [isLoadingIssues, setIsLoadingIssues] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [showDuplicateConfirm, setShowDuplicateConfirm] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [importResult, setImportResult] = useState<JiraImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadCounter, setReloadCounter] = useState(0);

  const requestIdRef = useRef(0);
  const selectedProjectKey = projectOverride ?? defaultProjectKey ?? '';

  // Load Jira projects when the modal opens
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await window.electronAPI.getJiraProjects(projectId);
        if (cancelled) return;
        if (result.success && result.data) {
          setJiraProjects(result.data);
        } else {
          setError(result.error || t('import.errors.loadProjects'));
        }
      } catch {
        if (!cancelled) setError(t('import.errors.loadProjects'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, projectId, t]);

  // Debounce the search text sent to the server
  useEffect(() => {
    const timer = setTimeout(() => setSearchText(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Load the first page of issues
  useEffect(() => {
    if (!open) return;
    const requestId = ++requestIdRef.current;
    setIsLoadingIssues(true);
    setError(null);
    // reloadCounter is an intentional dependency: bumping it forces a refetch
    void reloadCounter;
    (async () => {
      try {
        const result = await window.electronAPI.getJiraIssues(projectId, {
          projectKey: selectedProjectKey || undefined,
          searchText: searchText || undefined
        });
        if (requestId !== requestIdRef.current) return;
        if (result.success && result.data) {
          setIssues(result.data.issues);
          setNextPageToken(result.data.isLast ? undefined : result.data.nextPageToken);
          setSelectedKeys(new Set());
          setShowDuplicateConfirm(false);
        } else {
          setIssues([]);
          setNextPageToken(undefined);
          setError(result.error || t('import.errors.loadIssues'));
        }
      } catch {
        if (requestId !== requestIdRef.current) return;
        setIssues([]);
        setNextPageToken(undefined);
        setError(t('import.errors.loadIssues'));
      } finally {
        if (requestId === requestIdRef.current) setIsLoadingIssues(false);
      }
    })();
  }, [open, projectId, selectedProjectKey, searchText, reloadCounter, t]);

  const loadMore = useCallback(async () => {
    if (!nextPageToken || isLoadingMore) return;
    const requestId = requestIdRef.current;
    setIsLoadingMore(true);
    try {
      const result = await window.electronAPI.getJiraIssues(projectId, {
        projectKey: selectedProjectKey || undefined,
        searchText: searchText || undefined,
        nextPageToken
      });
      if (requestId !== requestIdRef.current) return;
      if (result.success && result.data) {
        const page = result.data;
        setIssues((prev) => {
          const known = new Set(prev.map((i) => i.key));
          return [...prev, ...page.issues.filter((i) => !known.has(i.key))];
        });
        setNextPageToken(page.isLast ? undefined : page.nextPageToken);
      } else {
        setError(result.error || t('import.errors.loadIssues'));
      }
    } catch {
      setError(t('import.errors.loadIssues'));
    } finally {
      setIsLoadingMore(false);
    }
  }, [nextPageToken, isLoadingMore, projectId, selectedProjectKey, searchText, t]);

  const toggleIssue = useCallback((key: string) => {
    setShowDuplicateConfirm(false);
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setShowDuplicateConfirm(false);
    setSelectedKeys(new Set(issues.map((i) => i.key)));
  }, [issues]);

  const deselectAll = useCallback(() => {
    setShowDuplicateConfirm(false);
    setSelectedKeys(new Set());
  }, []);

  const setSelectedProjectKey = useCallback((key: string) => {
    setProjectOverride(key);
  }, []);

  const handleRefresh = useCallback(() => setReloadCounter((c) => c + 1), []);

  const runImport = useCallback(
    async (keys: string[], allowDuplicates: boolean) => {
      setShowDuplicateConfirm(false);
      if (keys.length === 0) return;
      setIsImporting(true);
      setError(null);
      try {
        const result = await window.electronAPI.importJiraIssues(
          projectId,
          keys,
          allowDuplicates
        );
        if (result.success && result.data) {
          setImportResult(result.data);
          onImportComplete?.(result.data);
        } else {
          setError(result.error || t('import.errors.import'));
        }
      } catch {
        setError(t('import.errors.import'));
      } finally {
        setIsImporting(false);
      }
    },
    [projectId, onImportComplete, t]
  );

  const duplicateKeys = issues
    .filter((i) => i.alreadyImported && selectedKeys.has(i.key))
    .map((i) => i.key);

  const handleImport = useCallback(() => {
    if (selectedKeys.size === 0) return;
    if (duplicateKeys.length > 0) {
      setShowDuplicateConfirm(true);
      return;
    }
    void runImport(Array.from(selectedKeys), false);
  }, [selectedKeys, duplicateKeys.length, runImport]);

  const confirmReimport = useCallback(() => {
    void runImport(Array.from(selectedKeys), true);
  }, [selectedKeys, runImport]);

  const skipReimport = useCallback(() => {
    const dupes = new Set(duplicateKeys);
    void runImport(
      Array.from(selectedKeys).filter((k) => !dupes.has(k)),
      false
    );
  }, [selectedKeys, duplicateKeys, runImport]);

  const resetState = useCallback(() => {
    requestIdRef.current++;
    setJiraProjects([]);
    setProjectOverride(null);
    setSearchInput('');
    setSearchText('');
    setIssues([]);
    setNextPageToken(undefined);
    setIsLoadingIssues(false);
    setSelectedKeys(new Set());
    setShowDuplicateConfirm(false);
    setIsImporting(false);
    setImportResult(null);
    setError(null);
  }, []);

  return {
    jiraProjects,
    selectedProjectKey,
    searchInput,
    issues,
    hasMore: Boolean(nextPageToken),
    isLoadingIssues,
    isLoadingMore,
    selectedKeys,
    duplicateCount: duplicateKeys.length,
    showDuplicateConfirm,
    isImporting,
    importResult,
    error,
    setSelectedProjectKey,
    setSearchInput,
    loadMore,
    toggleIssue,
    selectAll,
    deselectAll,
    handleRefresh,
    handleImport,
    confirmReimport,
    skipReimport,
    resetState
  };
}
