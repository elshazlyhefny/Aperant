import { debugLog } from '@shared/utils/debug-logger';
import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { useProjectStore } from '../../../stores/project-store';
import { useSettingsStore } from '../../../stores/settings-store';
import { checkTaskRunning, isIncompleteHumanReview, getTaskProgress, useTaskStore, loadTasks, hasRecentActivity } from '../../../stores/task-store';
import type { Task, TaskLogs, TaskLogPhase, WorktreeStatus, WorktreeDiff, MergeConflict, MergeStats, GitConflictInfo, ImageAttachment, IPCResult } from '../../../../shared/types';
import { applyLogsDelta } from './applyLogsDelta';

/**
 * Validates task subtasks structure to prevent infinite loops during resume.
 * Returns true if task has valid subtasks, false otherwise.
 */
function validateTaskSubtasks(task: Task): boolean {
  // Check if subtasks array exists
  if (!task.subtasks || !Array.isArray(task.subtasks)) {
    console.warn('[validateTaskSubtasks] Task has no subtasks array:', task.id);
    return false;
  }

  // If subtasks array is empty and task is incomplete, it needs plan reload
  if (task.subtasks.length === 0) {
    console.warn('[validateTaskSubtasks] Task has empty subtasks array:', task.id);
    return false;
  }

  // Validate each subtask has minimum required fields
  for (let i = 0; i < task.subtasks.length; i++) {
    const subtask = task.subtasks[i];
    if (!subtask || typeof subtask !== 'object') {
      console.warn(`[validateTaskSubtasks] Invalid subtask at index ${i}:`, subtask);
      return false;
    }

    // Title is the primary display field
    if (!subtask.title || typeof subtask.title !== 'string' || subtask.title.trim() === '') {
      console.warn(`[validateTaskSubtasks] Subtask at index ${i} missing title:`, subtask);
      return false;
    }

    // ID is required for tracking
    if (!subtask.id || typeof subtask.id !== 'string') {
      console.warn(`[validateTaskSubtasks] Subtask at index ${i} missing id:`, subtask);
      return false;
    }
  }

  return true;
}

export interface UseTaskDetailOptions {
  task: Task;
}

// zeenha fork: A failed lookup is not verified absence, and either lookup can fail independently.
export type WorkspaceCheckState = 'idle' | 'loading' | 'success' | 'error';

type WorkspaceCheck = { state: WorkspaceCheckState; error: string | null };
type WorkspaceQuery<T> = { data: T | null; check: WorkspaceCheck };
type WorkspaceCheckOutcome<T> = { data: T; error: null } | { data: null; error: string };

const idleWorkspaceQuery = { data: null, check: { state: 'idle', error: null } } as const;
const loadingCheck = { state: 'loading', error: null } as const;
const successfulCheck = { state: 'success', error: null } as const;

function classifyWorkspaceCheck<T>(result: PromiseSettledResult<IPCResult<T>>, fallback: string): WorkspaceCheckOutcome<T> {
  if (result.status === 'rejected') {
    const reason: unknown = result.reason;
    const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : null;
    return { data: null, error: message || fallback };
  }
  const { success, data, error } = result.value;
  return success && data
    ? { data, error: null }
    : { data: null, error: error || fallback };
}

async function requestWorkspaceCheck<T>(request: () => Promise<IPCResult<T>>, fallback: string) {
  try {
    return classifyWorkspaceCheck({ status: 'fulfilled', value: await request() }, fallback);
  } catch (reason) {
    return classifyWorkspaceCheck<T>({ status: 'rejected', reason }, fallback);
  }
}

export function useTaskDetail({ task }: UseTaskDetailOptions) {
  const [feedback, setFeedback] = useState('');
  const [feedbackImages, setFeedbackImages] = useState<ImageAttachment[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  const [isStuck, setIsStuck] = useState(false);
  const [isRecovering, setIsRecovering] = useState(false);
  const [hasCheckedRunning, setHasCheckedRunning] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [worktreeChangesInfo, setWorktreeChangesInfo] = useState<{ hasChanges: boolean; worktreePath?: string; changedFileCount?: number } | null>(null);
  const [isCheckingChanges, setIsCheckingChanges] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [{ data: worktreeStatus, check: worktreeStatusCheck }, setStatusQuery] = useState<WorkspaceQuery<WorktreeStatus>>(idleWorkspaceQuery);
  const [{ data: worktreeDiff, check: worktreeDiffCheck }, setDiffQuery] = useState<WorkspaceQuery<WorktreeDiff>>(idleWorkspaceQuery);
  const activeTaskIdRef = useRef<string | null>(null);
  const statusRequestSeqRef = useRef(0);
  const diffRequestSeqRef = useRef(0);
  const previewRequestSeqRef = useRef(0);
  const [isMerging, setIsMerging] = useState(false);
  const [isDiscarding, setIsDiscarding] = useState(false);
  const [showDiscardDialog, setShowDiscardDialog] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [showDiffDialog, setShowDiffDialog] = useState(false);
  const [stageOnly, setStageOnly] = useState(false); // Default to full merge for proper cleanup (fixes #243)
  const [stagedSuccess, setStagedSuccess] = useState<string | null>(null);
  const [stagedProjectPath, setStagedProjectPath] = useState<string | undefined>(undefined);
  const [suggestedCommitMessage, setSuggestedCommitMessage] = useState<string | undefined>(undefined);
  const [phaseLogs, setPhaseLogs] = useState<TaskLogs | null>(null);
  const [isLoadingLogs, setIsLoadingLogs] = useState(false);
  const [expandedPhases, setExpandedPhases] = useState<Set<TaskLogPhase>>(new Set());
  const [isLoadingPlan, setIsLoadingPlan] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const logsContainerRef = useRef<HTMLDivElement>(null);

  // Merge preview state
  const [mergePreview, setMergePreview] = useState<{
    files: string[];
    conflicts: MergeConflict[];
    summary: MergeStats;
    gitConflicts?: GitConflictInfo;
  } | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [showConflictDialog, setShowConflictDialog] = useState(false);
  const [showPRDialog, setShowPRDialog] = useState(false);
  const [isCreatingPR, setIsCreatingPR] = useState(false);

  const currentProject = useProjectStore((state) => {
    const currentProjectId = state.activeProjectId || state.selectedProjectId;
    return currentProjectId
      ? state.projects.find((project) => project.id === currentProjectId)
      : undefined;
  });
  const logOrder = useSettingsStore(s => s.settings.logOrder);
  const isRunning = task.status === 'in_progress';
  // isActiveTask includes ai_review for stuck detection (CHANGELOG documents this feature)
  const isActiveTask = task.status === 'in_progress' || task.status === 'ai_review';
  const needsReview = task.status === 'human_review' && task.reviewReason !== 'account_required';
  const executionPhase = task.executionProgress?.phase;
  const hasActiveExecution = executionPhase && executionPhase !== 'idle' && executionPhase !== 'complete' && executionPhase !== 'failed';
  const isIncomplete = isIncompleteHumanReview(task);
  const taskProgress = getTaskProgress(task);

  // Catastrophic stuck detection — last-resort safety net.
  // XState handles all normal process-exit transitions via PROCESS_EXITED events.
  // This only fires if XState somehow fails to transition after 60s with no activity.
  useEffect(() => {
    if (!isActiveTask) {
      setIsStuck(false);
      setHasCheckedRunning(false);
      return;
    }

    const intervalId = setInterval(() => {
      if (hasRecentActivity(task.id)) {
        setIsStuck(false);
        return;
      }

      checkTaskRunning(task.id).then((actuallyRunning) => {
        if (hasRecentActivity(task.id)) {
          setIsStuck(false);
        } else {
          setIsStuck(!actuallyRunning);
        }
        setHasCheckedRunning(true);
      });
    }, 60_000);

    return () => clearInterval(intervalId);
  }, [task.id, isActiveTask]);

  // Check for uncommitted worktree changes when delete dialog opens
  useEffect(() => {
    if (showDeleteDialog && task) {
      setIsCheckingChanges(true);
      window.electronAPI.checkWorktreeChanges(task.id).then((result) => {
        if (result.success && result.data) {
          setWorktreeChangesInfo(result.data);
        }
        setIsCheckingChanges(false);
      }).catch(() => setIsCheckingChanges(false));
    } else {
      setWorktreeChangesInfo(null);
    }
  }, [showDeleteDialog, task]);

  // Handle scroll events in logs to detect if user scrolled away from anchor
  const handleLogsScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.target as HTMLDivElement;
    const isReverseOrder = logOrder === 'reverse-chronological';

    // Check distance from top for reverse order, bottom for chronological
    const isAtAnchor = isReverseOrder
      ? target.scrollTop < 100
      : target.scrollHeight - target.scrollTop - target.clientHeight < 100;

    setIsUserScrolledUp(!isAtAnchor);
  };

  const jumpToLatestLogs = useCallback(() => {
    const container = logsContainerRef.current;
    if (container) {
      // zeenha fork: Jump instantly so the 100px scroll-away check can't pause following mid-animation.
      container.scrollTop = logOrder === 'reverse-chronological' ? 0 : container.scrollHeight;
    }
    setIsUserScrolledUp(false);
  }, [logOrder]);

  // Auto-scroll logs to anchor (top for reverse, bottom for chronological) only if user hasn't scrolled away
  useEffect(() => {
    const isReverseOrder = logOrder === 'reverse-chronological';

    if (activeTab === 'logs' && !isUserScrolledUp) {
      if (isReverseOrder && logsContainerRef.current) {
        logsContainerRef.current.scrollTo({ top: 0, behavior: 'smooth' });
      } else if (!isReverseOrder && logsEndRef.current) {
        logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
      }
    }
  }, [activeTab, isUserScrolledUp, logOrder, phaseLogs]);

  // Reset scroll state when switching to logs tab
  useEffect(() => {
    if (activeTab === 'logs') {
      setIsUserScrolledUp(false);
    }
  }, [activeTab]);

  // Reset feedback images when task changes to prevent image leakage between tasks
  useEffect(() => {
    setFeedbackImages([]);
  }, []);

  // zeenha fork: Only the latest request for each check can publish for the active task.
  const runStatusCheck = useCallback(async (preserveOnError = false) => {
    const taskId = task.id;
    if (activeTaskIdRef.current !== taskId) return;
    const seq = ++statusRequestSeqRef.current;
    // A background merge-preview refresh shouldn't hide the verified workspace.
    setStatusQuery(previous => preserveOnError && previous.check.state === 'success'
      ? previous
      : { ...previous, check: loadingCheck });
    const outcome = await requestWorkspaceCheck(
      () => window.electronAPI.getWorktreeStatus(taskId),
      'Failed to load worktree status'
    );
    if (activeTaskIdRef.current !== taskId || statusRequestSeqRef.current !== seq) return;

    setStatusQuery(previous => {
      if (outcome.data !== null) return { data: outcome.data, check: successfulCheck };
      const check: WorkspaceCheck = preserveOnError && previous.data !== null
        ? successfulCheck
        : { state: 'error', error: outcome.error };
      return { ...previous, check };
    });
    return { seq, error: outcome.error };
  }, [task.id]);

  const runDiffCheck = useCallback(async () => {
    const taskId = task.id;
    if (activeTaskIdRef.current !== taskId) return;
    const seq = ++diffRequestSeqRef.current;
    setDiffQuery(previous => ({ ...previous, check: loadingCheck }));
    const outcome = await requestWorkspaceCheck(
      () => window.electronAPI.getWorktreeDiff(taskId),
      'Failed to load worktree diff'
    );
    if (activeTaskIdRef.current !== taskId || diffRequestSeqRef.current !== seq) return;

    setDiffQuery(previous => outcome.data !== null
      ? { data: outcome.data, check: successfulCheck }
      : { ...previous, check: { state: 'error', error: outcome.error } });
  }, [task.id]);

  const retryWorktreeStatus = useCallback(async () => { await runStatusCheck(); }, [runStatusCheck]);
  const retryWorktreeDiff = runDiffCheck;

  // zeenha fork: Reset before paint so the next task never displays the previous task's workspace.
  useLayoutEffect(() => {
    activeTaskIdRef.current = needsReview ? task.id : null;
    setStatusQuery(idleWorkspaceQuery);
    setDiffQuery(idleWorkspaceQuery);
    setMergePreview(null);
    setIsLoadingPreview(false);
    setWorkspaceError(null);
    if (needsReview) {
      void runStatusCheck();
      void runDiffCheck();
    }

    return () => {
      activeTaskIdRef.current = null;
      statusRequestSeqRef.current++;
      diffRequestSeqRef.current++;
      previewRequestSeqRef.current++;
    };
  }, [task.id, needsReview, runStatusCheck, runDiffCheck]);

  // Load and watch phase logs
  useEffect(() => {
    if (!currentProject) return;

    // Latest logs held by this effect; deltas are applied against it so the
    // resync decision happens outside of a state updater.
    let current: TaskLogs | null = null;
    let resyncInFlight = false;
    let cancelled = false;

    const phaseOrder: TaskLogPhase[] = ['planning', 'coding', 'validation'];
    const expandActive = (logs: TaskLogs, replace: boolean) => {
      const activePhase = phaseOrder.find(phase => logs.phases[phase]?.status === 'active');
      if (!activePhase) return;
      if (replace) {
        setExpandedPhases(new Set([activePhase]));
      } else {
        setExpandedPhases(prev => {
          const next = new Set(prev);
          next.add(activePhase);
          return next;
        });
      }
    };

    const loadLogs = async (showLoading: boolean) => {
      if (showLoading) setIsLoadingLogs(true);
      try {
        const result = await window.electronAPI.getTaskLogs(currentProject.id, task.specId);
        if (!cancelled && result.success && result.data) {
          current = result.data;
          setPhaseLogs(result.data);
          expandActive(result.data, showLoading);
        }
      } catch (err) {
        console.error('Failed to load task logs:', err);
      } finally {
        if (showLoading) setIsLoadingLogs(false);
      }
    };

    loadLogs(true);

    // Start watching for log changes
    window.electronAPI.watchTaskLogs(currentProject.id, task.specId);

    // Full-log updates (initial/resync emits)
    const unsubscribe = window.electronAPI.onTaskLogsChanged((specId, logs) => {
      if (specId === task.specId) {
        current = logs;
        setPhaseLogs(logs);
        expandActive(logs, false);
      }
    });

    // Incremental updates: only the entries appended since the last emit
    const unsubscribeAppended = window.electronAPI.onTaskLogsAppended((specId, delta) => {
      if (specId !== task.specId) return;
      const next = applyLogsDelta(current, delta);
      if (next) {
        current = next;
        setPhaseLogs(next);
        expandActive(next, false);
        return;
      }
      // Delta does not line up with what we hold: reload the full log (one at a time)
      if (resyncInFlight) return;
      resyncInFlight = true;
      loadLogs(false).finally(() => {
        resyncInFlight = false;
      });
    });

    return () => {
      cancelled = true;
      unsubscribe();
      unsubscribeAppended();
      window.electronAPI.unwatchTaskLogs(task.specId);
    };
  }, [currentProject, task.specId]);

  // Toggle phase expansion
  const togglePhase = useCallback((phase: TaskLogPhase) => {
    setExpandedPhases(prev => {
      const next = new Set(prev);
      if (next.has(phase)) {
        next.delete(phase);
      } else {
        next.add(phase);
      }
      return next;
    });
  }, []);

  // Add a feedback image
  const addFeedbackImage = useCallback((image: ImageAttachment) => {
    setFeedbackImages(prev => [...prev, image]);
  }, []);

  // Add multiple feedback images at once
  const addFeedbackImages = useCallback((images: ImageAttachment[]) => {
    setFeedbackImages(prev => [...prev, ...images]);
  }, []);

  // Remove a feedback image by ID
  const removeFeedbackImage = useCallback((imageId: string) => {
    setFeedbackImages(prev => prev.filter(img => img.id !== imageId));
  }, []);

  // Clear all feedback images
  const clearFeedbackImages = useCallback(() => {
    setFeedbackImages([]);
  }, []);

  // zeenha fork: Refresh status through the same guard used by the initial check and retries.
  const loadMergePreview = useCallback(async () => {
    const taskId = task.id;
    if (activeTaskIdRef.current !== taskId) return;
    const seq = ++previewRequestSeqRef.current;
    setIsLoadingPreview(true);
    setWorkspaceError(null);

    const [preview, status] = await Promise.all([
      requestWorkspaceCheck(() => window.electronAPI.mergeWorktreePreview(taskId), 'Failed to load merge preview'),
      runStatusCheck(true)
    ]);
    if (activeTaskIdRef.current !== taskId || previewRequestSeqRef.current !== seq) return;

    const errors: string[] = [];
    if (preview.data?.preview) setMergePreview(preview.data.preview);
    if (preview.error) errors.push(`Merge preview: ${preview.error}`);
    if (status?.error && statusRequestSeqRef.current === status.seq) {
      errors.push(`Worktree status: ${status.error}`);
    }
    if (errors.length > 0) setWorkspaceError(errors.join('; '));
    setIsLoadingPreview(false);
  }, [task.id, runStatusCheck]);

  // Handle "Review Again" - clears staged state and reloads worktree info
  const handleReviewAgain = useCallback(async () => {
    if (activeTaskIdRef.current !== task.id) return;

    // Clear staged success state if it was set in this session
    setStagedSuccess(null);
    setStagedProjectPath(undefined);
    setSuggestedCommitMessage(undefined);

    // Reset merge preview to force re-check
    previewRequestSeqRef.current++;
    setMergePreview(null);
    setIsLoadingPreview(false);

    // Reset workspace error state
    setWorkspaceError(null);

    // zeenha fork: Each reload publishes independently, even if the other check fails.
    const statusRequest = runStatusCheck();
    const diffRequest = runDiffCheck();
    try {
      await statusRequest;
      await diffRequest;
      // Reload task data from store to reflect cleared staged state
      // (clearStagedState IPC already invalidated the cache)
      if (currentProject) {
        await loadTasks(currentProject.id);
      }
    } catch (err) {
      console.error('Failed to reload worktree info:', err);
    }
  }, [task.id, currentProject, runStatusCheck, runDiffCheck]);

  // NOTE: Merge preview is NO LONGER auto-loaded on modal open.
  // User must click "Check for Conflicts" button to trigger the expensive preview operation.
  // This improves modal open performance significantly (avoids 1-30+ second Python subprocess).

  /**
   * Reloads implementation plan for an incomplete task to ensure subtasks are properly loaded.
   * This prevents the "Task Incomplete" infinite loop when resuming stuck tasks.
   */
  const reloadPlanForIncompleteTask = useCallback(async (): Promise<boolean> => {
    if (!currentProject) {
      console.error('[reloadPlanForIncompleteTask] No current project');
      return false;
    }

    // Only reload if task is incomplete and subtasks are invalid
    if (!isIncomplete) {
      return true; // Not incomplete, no reload needed
    }

    // Check if subtasks are valid
    if (validateTaskSubtasks(task)) {
      debugLog('[reloadPlanForIncompleteTask] Subtasks are valid, no reload needed');
      return true; // Subtasks are valid, proceed
    }

    console.warn('[reloadPlanForIncompleteTask] Task has invalid subtasks, reloading plan:', {
      taskId: task.id,
      specId: task.specId,
      subtaskCount: task.subtasks?.length || 0
    });

    setIsLoadingPlan(true);
    try {
      // Reload tasks from the project to get fresh implementation plan
      const result = await window.electronAPI.getTasks(currentProject.id);

      if (!result.success || !result.data) {
        console.error('[reloadPlanForIncompleteTask] Failed to reload tasks:', result.error);
        return false;
      }

      // Find the updated task in the result
      const updatedTask = result.data.find(t => t.id === task.id || t.specId === task.specId);
      if (!updatedTask) {
        console.error('[reloadPlanForIncompleteTask] Task not found in reloaded tasks');
        return false;
      }

      // Validate the reloaded subtasks
      if (!validateTaskSubtasks(updatedTask)) {
        console.error('[reloadPlanForIncompleteTask] Reloaded task still has invalid subtasks');
        return false;
      }

      debugLog('[reloadPlanForIncompleteTask] Successfully reloaded plan with valid subtasks:', {
        taskId: task.id,
        subtaskCount: updatedTask.subtasks?.length ?? 0
      });

      // FIX (PR Review): Update the Zustand store with the reloaded task data
      // Without this, the UI continues to display stale/invalid subtasks
      const store = useTaskStore.getState();
      store.updateTask(task.id, {
        subtasks: updatedTask.subtasks,
        title: updatedTask.title,
        description: updatedTask.description,
        metadata: updatedTask.metadata,
        updatedAt: new Date()
      });

      return true;
    } catch (err) {
      console.error('[reloadPlanForIncompleteTask] Error reloading plan:', err);
      return false;
    } finally {
      setIsLoadingPlan(false);
    }
  }, [currentProject, task, isIncomplete]);

  return {
    // State
    feedback,
    feedbackImages,
    isSubmitting,
    activeTab,
    isUserScrolledUp,
    isStuck,
    isRecovering,
    hasCheckedRunning,
    showDeleteDialog,
    isDeleting,
    deleteError,
    worktreeChangesInfo,
    isCheckingChanges,
    isEditDialogOpen,
    worktreeStatus,
    worktreeDiff,
    worktreeStatusCheck,
    worktreeDiffCheck,
    isLoadingWorktree: worktreeStatusCheck.state === 'loading',
    isLoadingWorktreeDiff: worktreeDiffCheck.state === 'loading',
    isMerging,
    isDiscarding,
    showDiscardDialog,
    workspaceError,
    showDiffDialog,
    stageOnly,
    stagedSuccess,
    stagedProjectPath,
    suggestedCommitMessage,
    phaseLogs,
    isLoadingLogs,
    expandedPhases,
    logsEndRef,
    logsContainerRef,
    selectedProject: currentProject,
    isRunning,
    needsReview,
    executionPhase,
    hasActiveExecution,
    isIncomplete,
    taskProgress,
    mergePreview,
    isLoadingPreview,
    showConflictDialog,
    showPRDialog,
    isCreatingPR,
    isLoadingPlan,

    // Setters
    setFeedback,
    setFeedbackImages,
    setIsSubmitting,
    setActiveTab,
    setIsUserScrolledUp,
    setIsStuck,
    setIsRecovering,
    setHasCheckedRunning,
    setShowDeleteDialog,
    setIsDeleting,
    setDeleteError,
    setWorktreeChangesInfo,
    setIsCheckingChanges,
    setIsEditDialogOpen,
    setIsMerging,
    setIsDiscarding,
    setShowDiscardDialog,
    setWorkspaceError,
    setShowDiffDialog,
    setStageOnly,
    setStagedSuccess,
    setStagedProjectPath,
    setSuggestedCommitMessage,
    setPhaseLogs,
    setIsLoadingLogs,
    setExpandedPhases,
    setMergePreview,
    setIsLoadingPreview,
    setShowConflictDialog,
    setShowPRDialog,
    setIsCreatingPR,

    // Handlers
    handleLogsScroll,
    jumpToLatestLogs,
    togglePhase,
    loadMergePreview,
    retryWorktreeStatus,
    retryWorktreeDiff,
    addFeedbackImage,
    addFeedbackImages,
    removeFeedbackImage,
    clearFeedbackImages,
    handleReviewAgain,
    reloadPlanForIncompleteTask,
  };
}
