/**
 * State and IPC calls for the Azure Boards import modal.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AzureBoardsImportResult,
  AzureBoardsMetadata,
  AzureBoardsQueryRequest,
  AzureBoardsSavedQuery,
  AzureBoardsWorkItem
} from '../../../shared/types';
import { getFailedIds, mergeImportResults } from './import-result';

export type AzureBoardsQueryMode = 'filter' | 'saved';

export interface UseAzureBoardsImportProps {
  projectId: string;
  open: boolean;
  onImportComplete?: (result: AzureBoardsImportResult) => void;
}

function toggleInList(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export function useAzureBoardsImport({ projectId, open, onImportComplete }: UseAzureBoardsImportProps) {
  const { t } = useTranslation('azuredevops');

  const [savedQueries, setSavedQueries] = useState<AzureBoardsSavedQuery[]>([]);
  const [metadata, setMetadata] = useState<AzureBoardsMetadata>({ workItemTypes: [], states: [] });
  const [queryMode, setQueryMode] = useState<AzureBoardsQueryMode>('filter');
  const [areaPath, setAreaPath] = useState('');
  const [states, setStates] = useState<string[]>([]);
  const [workItemTypes, setWorkItemTypes] = useState<string[]>([]);
  const [savedQueryId, setSavedQueryId] = useState('');
  const [items, setItems] = useState<AzureBoardsWorkItem[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [hasRun, setHasRun] = useState(false);
  const [isLoadingItems, setIsLoadingItems] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [showDuplicateConfirm, setShowDuplicateConfirm] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [importResult, setImportResult] = useState<AzureBoardsImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const requestIdRef = useRef(0);
  const retryingRef = useRef(false);
  const retryRequestIdRef = useRef(0);

  // Load saved queries and metadata when the modal opens
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const [queries, meta] = await Promise.all([
          window.electronAPI.getAzureBoardsSavedQueries(projectId),
          window.electronAPI.getAzureBoardsMetadata(projectId)
        ]);
        if (cancelled) return;
        if (queries.success && queries.data) {
          setSavedQueries(queries.data);
        } else {
          setError(queries.error || t('boards.errors.loadQueries'));
        }
        if (meta.success && meta.data) {
          setMetadata(meta.data);
        } else {
          setError(meta.error || t('boards.errors.loadMetadata'));
        }
      } catch {
        if (!cancelled) setError(t('boards.errors.loadMetadata'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, projectId, t]);

  const runQuery = useCallback(async () => {
    const request: AzureBoardsQueryRequest =
      queryMode === 'saved'
        ? { savedQueryId }
        : {
            filter: {
              areaPath: areaPath.trim() || undefined,
              states: states.length > 0 ? states : undefined,
              workItemTypes: workItemTypes.length > 0 ? workItemTypes : undefined
            }
          };
    if (queryMode === 'saved' && !savedQueryId) return;
    const requestId = ++requestIdRef.current;
    setIsLoadingItems(true);
    setError(null);
    try {
      const result = await window.electronAPI.queryAzureBoardsWorkItems(projectId, request);
      if (requestId !== requestIdRef.current) return;
      if (result.success && result.data) {
        setItems(result.data.items);
        setTotalCount(result.data.totalCount);
        setTruncated(result.data.truncated);
        setSelectedIds(new Set());
        setShowDuplicateConfirm(false);
        setHasRun(true);
      } else {
        setItems([]);
        setTruncated(false);
        setError(result.error || t('boards.errors.query'));
      }
    } catch {
      if (requestId !== requestIdRef.current) return;
      setItems([]);
      setTruncated(false);
      setError(t('boards.errors.query'));
    } finally {
      if (requestId === requestIdRef.current) setIsLoadingItems(false);
    }
  }, [projectId, queryMode, savedQueryId, areaPath, states, workItemTypes, t]);

  const toggleState = useCallback((value: string) => setStates((prev) => toggleInList(prev, value)), []);
  const toggleWorkItemType = useCallback(
    (value: string) => setWorkItemTypes((prev) => toggleInList(prev, value)),
    []
  );

  const toggleItem = useCallback((id: number) => {
    setShowDuplicateConfirm(false);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setShowDuplicateConfirm(false);
    setSelectedIds(new Set(items.map((i) => i.id)));
  }, [items]);

  const deselectAll = useCallback(() => {
    setShowDuplicateConfirm(false);
    setSelectedIds(new Set());
  }, []);

  const runImport = useCallback(
    async (ids: number[], allowDuplicates: boolean) => {
      setShowDuplicateConfirm(false);
      if (ids.length === 0) return;
      setIsImporting(true);
      setError(null);
      try {
        const result = await window.electronAPI.importAzureBoardsWorkItems(
          projectId,
          ids,
          allowDuplicates
        );
        if (result.success && result.data) {
          setImportResult(result.data);
          onImportComplete?.(result.data);
        } else {
          setError(result.error || t('boards.errors.import'));
        }
      } catch {
        setError(t('boards.errors.import'));
      } finally {
        setIsImporting(false);
      }
    },
    [projectId, onImportComplete, t]
  );

  const retryFailed = useCallback(async () => {
    if (retryingRef.current || !importResult) return;
    const ids = getFailedIds(importResult);
    if (ids.length === 0) return;

    const requestId = ++retryRequestIdRef.current;
    retryingRef.current = true;
    setIsRetrying(true);
    setError(null);
    try {
      // zeenha fork: Retry only failed items and skip any that now have a spec.
      const result = await window.electronAPI.importAzureBoardsWorkItems(projectId, ids, false);
      if (result.success && result.data) {
        const data = result.data;
        if (requestId === retryRequestIdRef.current) {
          setImportResult((prev) => (prev ? mergeImportResults(prev, data) : data));
        }
        // Even if the modal closed, the parent still needs to refresh newly imported tasks.
        onImportComplete?.(data);
      } else if (requestId === retryRequestIdRef.current) {
        setError(result.error || t('boards.errors.retry'));
      }
    } catch {
      if (requestId === retryRequestIdRef.current) setError(t('boards.errors.retry'));
    } finally {
      if (requestId === retryRequestIdRef.current) {
        retryingRef.current = false;
        setIsRetrying(false);
      }
    }
  }, [importResult, projectId, onImportComplete, t]);

  const duplicateIds = items.filter((i) => i.alreadyImported && selectedIds.has(i.id)).map((i) => i.id);

  const handleImport = useCallback(() => {
    if (selectedIds.size === 0 || isImporting) return;
    if (duplicateIds.length > 0) {
      setShowDuplicateConfirm(true);
      return;
    }
    void runImport(Array.from(selectedIds), false);
  }, [selectedIds, isImporting, duplicateIds.length, runImport]);

  const confirmReimport = useCallback(() => {
    void runImport(Array.from(selectedIds), true);
  }, [selectedIds, runImport]);

  const skipReimport = useCallback(() => {
    const dupes = new Set(duplicateIds);
    void runImport(
      Array.from(selectedIds).filter((id) => !dupes.has(id)),
      false
    );
  }, [selectedIds, duplicateIds, runImport]);

  const resetState = useCallback(() => {
    requestIdRef.current++;
    retryRequestIdRef.current++;
    retryingRef.current = false;
    setSavedQueries([]);
    setMetadata({ workItemTypes: [], states: [] });
    setQueryMode('filter');
    setAreaPath('');
    setStates([]);
    setWorkItemTypes([]);
    setSavedQueryId('');
    setItems([]);
    setTotalCount(0);
    setTruncated(false);
    setHasRun(false);
    setIsLoadingItems(false);
    setSelectedIds(new Set());
    setShowDuplicateConfirm(false);
    setIsImporting(false);
    setIsRetrying(false);
    setImportResult(null);
    setError(null);
  }, []);

  return {
    savedQueries,
    metadata,
    queryMode,
    areaPath,
    states,
    workItemTypes,
    savedQueryId,
    items,
    totalCount,
    truncated,
    hasRun,
    isLoadingItems,
    selectedIds,
    duplicateCount: duplicateIds.length,
    showDuplicateConfirm,
    isImporting,
    isRetrying,
    failedIds: getFailedIds(importResult),
    importResult,
    error,
    setQueryMode,
    setAreaPath,
    setSavedQueryId,
    toggleState,
    toggleWorkItemType,
    runQuery,
    toggleItem,
    selectAll,
    deselectAll,
    handleImport,
    confirmReimport,
    skipReimport,
    retryFailed,
    resetState
  };
}
