import { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '../../../hooks/use-toast';
import {
  useIdeationStore,
  loadIdeation,
  generateIdeation,
  refreshIdeation,
  stopIdeation,
  appendIdeation,
  dismissAllIdeasForProject,
  deleteMultipleIdeasForProject,
  getIdeasByType,
  getActiveIdeas,
  getArchivedIdeas,
  getIdeationSummary,
  setupIdeationListeners
} from '../../../stores/ideation-store';
import { loadTasks } from '../../../stores/task-store';
import { useIdeationAuth } from './useIdeationAuth';
import type { Idea, IdeationType } from '../../../../shared/types';
import { ALL_IDEATION_TYPES } from '../constants';

type ConvertIdeaOutcome =
  | { status: 'success' }
  | { status: 'failure'; kind: 'result' | 'exception'; error?: string }
  | { status: 'skipped' };

interface UseIdeationOptions {
  onGoToTask?: (taskId: string) => void;
  /** External showArchived state from context - when provided, hook uses this instead of internal state */
  showArchived?: boolean;
}

export function useIdeation(projectId: string, options: UseIdeationOptions = {}) {
  const { onGoToTask, showArchived: externalShowArchived } = options;
  const { t } = useTranslation('common');
  const session = useIdeationStore((state) => state.session);
  const generationStatus = useIdeationStore((state) => state.generationStatus);
  const isGenerating = useIdeationStore((state) => state.isGenerating);
  const config = useIdeationStore((state) => state.config);
  const setConfig = useIdeationStore((state) => state.setConfig);
  const logs = useIdeationStore((state) => state.logs);
  const typeStates = useIdeationStore((state) => state.typeStates);
  const selectedIds = useIdeationStore((state) => state.selectedIds);
  const toggleSelectIdea = useIdeationStore((state) => state.toggleSelectIdea);
  const selectAllIdeas = useIdeationStore((state) => state.selectAllIdeas);
  const clearSelection = useIdeationStore((state) => state.clearSelection);

  const [selectedIdea, setSelectedIdea] = useState<Idea | null>(null);
  const [activeTab, setActiveTab] = useState<string>('all');
  const [showConfigDialog, setShowConfigDialog] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [showAddMoreDialog, setShowAddMoreDialog] = useState(false);
  const [typesToAdd, setTypesToAdd] = useState<IdeationType[]>([]);
  const [convertingIdeas, setConvertingIdeas] = useState<Set<string>>(new Set());
  // Ref for synchronous tracking - prevents race condition from stale React state closure
  const convertingIdeaRef = useRef<Set<string>>(new Set());
  // Prevents re-entrant bulk conversion runs
  const convertingSelectedRef = useRef(false);
  const [isConvertingSelected, setIsConvertingSelected] = useState(false);

  const { hasToken, isLoading: isCheckingToken } = useIdeationAuth();

  // Set up IPC listeners and load ideation on mount
  useEffect(() => {
    const cleanup = setupIdeationListeners();
    loadIdeation(projectId);
    return cleanup;
  }, [projectId]);

  const handleGenerate = async () => {
    if (hasToken === false) {
      toast({
        variant: 'destructive',
        title: t('errors.noProviderConfigured', 'No AI provider configured'),
        description: t('errors.configureProviderFirst', 'Please add a provider account in Settings to use AI features.'),
      });
      return;
    }
    generateIdeation(projectId);
  };

  const handleRefresh = async () => {
    if (hasToken === false) {
      toast({
        variant: 'destructive',
        title: t('errors.noProviderConfigured', 'No AI provider configured'),
        description: t('errors.configureProviderFirst', 'Please add a provider account in Settings to use AI features.'),
      });
      return;
    }
    refreshIdeation(projectId);
  };

  const handleStop = async () => {
    await stopIdeation(projectId);
  };

  const handleDismissAll = async () => {
    await dismissAllIdeasForProject(projectId);
  };

  const getAvailableTypesToAdd = (): IdeationType[] => {
    if (!session) return ALL_IDEATION_TYPES;
    // Only count types with active ideas (not dismissed or archived)
    // This allows users to regenerate types where all ideas were dismissed
    const existingTypes = new Set(
      session.ideas
        .filter((idea) => idea.status !== 'dismissed' && idea.status !== 'archived')
        .map((idea) => idea.type)
    );
    return ALL_IDEATION_TYPES.filter((type) => !existingTypes.has(type));
  };

  const handleAddMoreIdeas = () => {
    if (typesToAdd.length === 0) return;

    if (hasToken === false) {
      toast({
        variant: 'destructive',
        title: t('errors.noProviderConfigured', 'No AI provider configured'),
        description: t('errors.configureProviderFirst', 'Please add a provider account in Settings to use AI features.'),
      });
      return;
    }

    appendIdeation(projectId, typesToAdd);
    setTypesToAdd([]);
    setShowAddMoreDialog(false);
  };

  const toggleTypeToAdd = (type: IdeationType) => {
    setTypesToAdd((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]
    );
  };

  // Converts a single idea. Does not reload tasks or toast: callers decide how to report.
  const convertIdea = async (idea: Idea): Promise<ConvertIdeaOutcome> => {
    // Guard: use ref for synchronous check to prevent race condition from stale state closure
    // React state is captured at render time, so rapid clicks would both see empty set
    if (convertingIdeaRef.current.has(idea.id)) {
      return { status: 'skipped' };
    }

    // Mark as converting - update ref synchronously first, then state for UI
    convertingIdeaRef.current.add(idea.id);
    setConvertingIdeas(new Set(convertingIdeaRef.current));

    try {
      const result = await window.electronAPI.convertIdeaToTask(projectId, idea.id);
      if (result.success && result.data) {
        // Store the taskId on the idea so we can navigate to it later
        useIdeationStore.getState().setIdeaTaskId(idea.id, result.data.id);
        return { status: 'success' };
      }
      // Conversion failed (e.g., already converted, idea not found)
      return { status: 'failure', kind: 'result', error: result.error };
    } catch (error) {
      // Handle unexpected errors (network issues, etc.)
      console.error('Failed to convert idea to task:', error);
      return { status: 'failure', kind: 'exception' };
    } finally {
      // Always clear converting state - update ref first, then state
      convertingIdeaRef.current.delete(idea.id);
      setConvertingIdeas(new Set(convertingIdeaRef.current));
    }
  };

  const handleConvertToTask = async (idea: Idea) => {
    const outcome = await convertIdea(idea);
    if (outcome.status === 'success') {
      loadTasks(projectId);
    } else if (outcome.status === 'failure') {
      if (outcome.kind === 'result') {
        toast({
          variant: 'destructive',
          title: t('ideation.conversionFailed'),
          description: outcome.error || t('ideation.conversionFailedDescription')
        });
      } else {
        toast({
          variant: 'destructive',
          title: t('ideation.conversionError'),
          description: t('ideation.conversionErrorDescription')
        });
      }
    }
  };

  const handleConvertSelected = useCallback(async () => {
    if (convertingSelectedRef.current) return;

    // Get fresh state from store to avoid stale closure
    const { selectedIds: currentSelectedIds, session: currentSession } = useIdeationStore.getState();
    if (currentSelectedIds.size === 0 || !currentSession) return;

    // Same eligibility rule as IdeaCard: not dismissed/archived and not already converted
    const eligible = currentSession.ideas.filter(
      (idea) =>
        currentSelectedIds.has(idea.id) &&
        idea.status !== 'dismissed' &&
        idea.status !== 'archived' &&
        idea.status !== 'converted' &&
        !convertingIdeaRef.current.has(idea.id)
    );

    if (eligible.length === 0) {
      toast({ description: t('ideation.bulkConvertNoneEligible') });
      return;
    }

    convertingSelectedRef.current = true;
    setIsConvertingSelected(true);
    try {
      let succeeded = 0;
      let failed = 0;
      // Sequential on purpose: parallel conversions would contend on the spec number lock
      for (const idea of eligible) {
        const outcome = await convertIdea(idea);
        if (outcome.status === 'success') succeeded++;
        else if (outcome.status === 'failure') failed++;
      }

      if (succeeded > 0) {
        loadTasks(projectId);
      }
      useIdeationStore.getState().clearSelection();

      if (failed === 0) {
        toast({
          title: t('ideation.bulkConvertTitle'),
          description: t('ideation.bulkConvertSuccess', { count: succeeded })
        });
      } else if (succeeded > 0) {
        toast({
          variant: 'destructive',
          title: t('ideation.bulkConvertTitle'),
          description: t('ideation.bulkConvertPartial', {
            succeeded,
            failed,
            total: succeeded + failed
          })
        });
      } else {
        toast({
          variant: 'destructive',
          title: t('ideation.bulkConvertTitle'),
          description: t('ideation.bulkConvertFailed', { count: failed })
        });
      }
    } finally {
      convertingSelectedRef.current = false;
      setIsConvertingSelected(false);
    }
  }, [projectId, t]);

  const handleGoToTask = useCallback(
    (taskId: string) => {
      if (onGoToTask) {
        onGoToTask(taskId);
      }
    },
    [onGoToTask]
  );

  const handleDismiss = async (idea: Idea) => {
    const result = await window.electronAPI.dismissIdea(projectId, idea.id);
    if (result.success) {
      useIdeationStore.getState().dismissIdea(idea.id);
    }
  };

  const toggleIdeationType = (type: IdeationType) => {
    const currentTypes = config.enabledTypes;
    const newTypes = currentTypes.includes(type)
      ? currentTypes.filter((t) => t !== type)
      : [...currentTypes, type];

    if (newTypes.length > 0) {
      setConfig({ enabledTypes: newTypes });
    }
  };

  const handleDeleteSelected = useCallback(async () => {
    // Get fresh selectedIds from store to avoid stale closure
    const currentSelectedIds = useIdeationStore.getState().selectedIds;
    if (currentSelectedIds.size === 0) return;
    await deleteMultipleIdeasForProject(projectId, Array.from(currentSelectedIds));
  }, [projectId]);

  const handleSelectAll = useCallback((ideas: Idea[]) => {
    selectAllIdeas(ideas.map(idea => idea.id));
  }, [selectAllIdeas]);

  const summary = getIdeationSummary(session);
  const archivedIdeas = getArchivedIdeas(session);

  // Compute effective showArchived: use external value (from context) if provided, else internal state
  // This eliminates render lag by using the context value directly instead of syncing via useEffect
  const effectiveShowArchived = externalShowArchived !== undefined ? externalShowArchived : showArchived;

  // Filter ideas based on visibility settings
  const getFilteredIdeas = useCallback(() => {
    if (!session) return [];
    let ideas = session.ideas;

    // Start with base filtering (exclude dismissed and archived by default)
    if (!showDismissed && !effectiveShowArchived) {
      ideas = getActiveIdeas(session);
    } else if (showDismissed && !effectiveShowArchived) {
      // Show dismissed but not archived
      ideas = ideas.filter(idea => idea.status !== 'archived');
    } else if (!showDismissed && effectiveShowArchived) {
      // Show archived but not dismissed
      ideas = ideas.filter(idea => idea.status !== 'dismissed');
    }
    // If both are true, show all

    return ideas;
  }, [session, showDismissed, effectiveShowArchived]);

  const activeIdeas = getFilteredIdeas();

  return {
    // State
    session,
    generationStatus,
    isGenerating,
    config,
    logs,
    typeStates,
    selectedIdea,
    activeTab,
    showConfigDialog,
    showDismissed,
    // Return the effective showArchived (external or internal) for consistent state reading
    showArchived: effectiveShowArchived,
    showAddMoreDialog,
    typesToAdd,
    hasToken,
    isCheckingToken,
    summary,
    activeIdeas,
    archivedIdeas,
    selectedIds,
    convertingIdeas,
    isConvertingSelected,

    // Actions
    setSelectedIdea,
    setActiveTab,
    setShowConfigDialog,
    setShowDismissed,
    setShowArchived,
    setShowAddMoreDialog,
    setTypesToAdd,
    setConfig,
    handleGenerate,
    handleRefresh,
    handleStop,
    handleDismissAll,
    handleDeleteSelected,
    handleSelectAll,
    getAvailableTypesToAdd,
    handleAddMoreIdeas,
    toggleTypeToAdd,
    handleConvertToTask,
    handleConvertSelected,
    handleGoToTask,
    handleDismiss,
    toggleIdeationType,
    toggleSelectIdea,
    clearSelection,

    // Helper functions
    getIdeasByType: (type: IdeationType) => getIdeasByType(session, type)
  };
}
