/**
 * State and IPC calls for the Azure Boards import modal.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AzureBoardsImportResult,
  AzureBoardsMetadata,
  AzureBoardsQueryRequest,
  AzureBoardsQueryResult,
  AzureBoardsSavedQuery
} from '../../../shared/types';

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
  const [queryResult, setQueryResult] = useState<{
    requestId: number;
    data: AzureBoardsQueryResult;
  } | null>(null);
  const [isLoadingItems, setIsLoadingItems] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [showDuplicateConfirm, setShowDuplicateConfirm] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [importResult, setImportResult] = useState<AzureBoardsImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const requestIdRef = useRef(0);

  const deselectAll = useCallback(() => {
    setShowDuplicateConfirm(false);
    setSelectedIds(new Set());
  }, []);

  const invalidateResult = useCallback(() => {
    setQueryResult(null);
    deselectAll();
  }, [deselectAll]);

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
    invalidateResult();
    setIsLoadingItems(true);
    setError(null);
    try {
      const result = await window.electronAPI.queryAzureBoardsWorkItems(projectId, request);
      if (requestId !== requestIdRef.current) return;
      if (result.success && result.data) {
        setQueryResult({ requestId, data: result.data });
      } else {
        invalidateResult();
        setError(result.error || t('boards.errors.query'));
      }
    } catch {
      if (requestId !== requestIdRef.current) return;
      invalidateResult();
      setError(t('boards.errors.query'));
    } finally {
      if (requestId === requestIdRef.current) setIsLoadingItems(false);
    }
  }, [projectId, queryMode, savedQueryId, areaPath, states, workItemTypes, t, invalidateResult]);

  const toggleState = useCallback((value: string) => setStates((prev) => toggleInList(prev, value)), []);
  const toggleWorkItemType = useCallback(
    (value: string) => setWorkItemTypes((prev) => toggleInList(prev, value)),
    []
  );

  const itemsById = useMemo(
    () => new Map(queryResult?.data.items.map((item) => [item.id, item])),
    [queryResult]
  );
  const resultRequestId = queryResult?.requestId;
  // A query can invalidate the snapshot before React renders the new state.
  const isCurrentResult = useCallback(
    () => resultRequestId === requestIdRef.current,
    [resultRequestId]
  );

  const toggleItem = useCallback(
    (id: number) => {
      if (!isCurrentResult() || !itemsById.has(id)) return;
      setShowDuplicateConfirm(false);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [isCurrentResult, itemsById]
  );

  const selectAll = useCallback(() => {
    if (!isCurrentResult()) return;
    setShowDuplicateConfirm(false);
    setSelectedIds(new Set(itemsById.keys()));
  }, [isCurrentResult, itemsById]);

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

  const { eligibleIds, duplicateIds } = useMemo(() => {
    const eligibleIds = new Set<number>();
    const duplicateIds = new Set<number>();
    for (const id of selectedIds) {
      const item = itemsById.get(id);
      if (!item) continue;
      eligibleIds.add(id);
      if (item.alreadyImported) duplicateIds.add(id);
    }
    return { eligibleIds, duplicateIds };
  }, [selectedIds, itemsById]);

  const canImport = queryResult !== null && eligibleIds.size > 0 && !isLoadingItems && !isImporting;
  const hasDuplicatePrompt = canImport && showDuplicateConfirm && duplicateIds.size > 0;

  const handleImport = useCallback(() => {
    if (!canImport || !isCurrentResult()) return;
    if (duplicateIds.size > 0) {
      setShowDuplicateConfirm(true);
      return;
    }
    void runImport(Array.from(eligibleIds), false);
  }, [canImport, isCurrentResult, duplicateIds.size, eligibleIds, runImport]);

  const confirmReimport = useCallback(() => {
    if (!hasDuplicatePrompt || !isCurrentResult()) return;
    void runImport(Array.from(eligibleIds), true);
  }, [hasDuplicatePrompt, isCurrentResult, eligibleIds, runImport]);

  const skipReimport = useCallback(() => {
    if (!hasDuplicatePrompt || !isCurrentResult()) return;
    void runImport(
      Array.from(eligibleIds).filter((id) => !duplicateIds.has(id)),
      false
    );
  }, [hasDuplicatePrompt, isCurrentResult, eligibleIds, duplicateIds, runImport]);

  const resetState = useCallback(() => {
    requestIdRef.current++;
    setSavedQueries([]);
    setMetadata({ workItemTypes: [], states: [] });
    setQueryMode('filter');
    setAreaPath('');
    setStates([]);
    setWorkItemTypes([]);
    setSavedQueryId('');
    invalidateResult();
    setIsLoadingItems(false);
    setIsImporting(false);
    setImportResult(null);
    setError(null);
  }, [invalidateResult]);

  return {
    savedQueries,
    metadata,
    queryMode,
    areaPath,
    states,
    workItemTypes,
    savedQueryId,
    items: queryResult?.data.items ?? [],
    totalCount: queryResult?.data.totalCount ?? 0,
    truncated: queryResult?.data.truncated ?? false,
    hasRun: queryResult !== null,
    isLoadingItems,
    selectedIds: eligibleIds,
    canImport,
    duplicateCount: duplicateIds.size,
    showDuplicateConfirm: hasDuplicatePrompt,
    isImporting,
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
    resetState
  };
}
