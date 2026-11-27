import { savedTaskAgent, taskPhaseMetadata } from '@shared/utils/task-agent';
/**
 * TaskEditDialog - Dialog for editing task details
 *
 * Allows users to modify all task properties including title, description,
 * classification fields, images, and review settings.
 *
 * Now uses the shared TaskModalLayout for consistent styling with other task modals,
 * and TaskFormFields for the form content.
 *
 * Features:
 * - Pre-populates form with current task values
 * - Form validation (description required)
 * - Editable classification fields (category, priority, complexity, impact)
 * - Editable image attachments (add/remove images)
 * - Editable review settings (requireReviewBeforeCoding)
 * - Saves changes via persistUpdateTask (updates store + spec files)
 * - Prevents save when no changes have been made
 *
 * @example
 * ```tsx
 * <TaskEditDialog
 *   task={selectedTask}
 *   open={isEditDialogOpen}
 *   onOpenChange={setIsEditDialogOpen}
 *   onSaved={() => console.log('Task updated!')}
 * />
 * ```
 */
import { useState, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button, buttonVariants } from './ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from './ui/alert-dialog';
import { TaskModalLayout } from './task-form/TaskModalLayout';
import { TaskFormFields } from './task-form/TaskFormFields';
import { TaskDependencyPicker, mapDependencyError } from './task-form/TaskDependencyPicker';
import { type FileReferenceData } from './task-form/useImageUpload';
import { persistUpdateTask, useTaskStore } from '../stores/task-store';
import { useProjectStore } from '../stores/project-store';
import { parseTokenBudgetText } from '../../shared/utils/token-budget';
import type { Task, ImageAttachment, TaskCategory, TaskPriority, TaskComplexity, TaskImpact, ModelType, ThinkingLevel } from '../../shared/types';
import {
  DEFAULT_AGENT_PROFILES,
  DEFAULT_PHASE_MODELS,
  DEFAULT_PHASE_THINKING,
  FAST_MODE_MODELS,
  PHASE_KEYS,
  getProviderPreset
} from '../../shared/constants';
import type { AppSettings, TaskAgentSelection, PhaseModelConfig, PhaseThinkingConfig } from '../../shared/types/settings';
import { useSettingsStore } from '../stores/settings-store';
import { useActiveProvider } from '../hooks/useActiveProvider';
import type { BuiltinProvider } from '../../shared/types/provider-account';

/**
 * Props for the TaskEditDialog component
 */
interface TaskEditDialogProps {
  /** The task to edit */
  task: Task;
  /** Whether the dialog is open */
  open: boolean;
  /** Callback when the dialog open state changes */
  onOpenChange: (open: boolean) => void;
  /** Optional callback when task is successfully saved */
  onSaved?: () => void;
}

interface EditValues {
  title: string;
  description: string;
  category: TaskCategory | '';
  priority: TaskPriority | '';
  complexity: TaskComplexity | '';
  impact: TaskImpact | '';
  taskAgent: TaskAgentSelection | null;
  profileId: string;
  model: ModelType | '';
  thinkingLevel: ThinkingLevel | '';
  phaseModels: PhaseModelConfig | undefined;
  phaseThinking: PhaseThinkingConfig | undefined;
  images: ImageAttachment[];
  requireReviewBeforeCoding: boolean;
  fastMode: boolean;
  taskDependencies: string[];
  tokenBudgetText: string;
}

function initializeEditValues(task: Task, settings: AppSettings, activeProvider: BuiltinProvider | null): EditValues {
  // Resolve per-provider settings (same chain as AgentProfileSettings)
  const providerConfig = activeProvider ? settings.providerAgentConfig?.[activeProvider] : undefined;
  const resolvedProfileId = providerConfig?.selectedAgentProfile ?? settings.selectedAgentProfile ?? 'auto';
  const selectedProfile = DEFAULT_AGENT_PROFILES.find(
    p => p.id === resolvedProfileId
  ) || DEFAULT_AGENT_PROFILES.find(p => p.id === 'auto')!;
  const providerPreset = activeProvider ? getProviderPreset(activeProvider, resolvedProfileId) : null;
  const metadata = task.metadata;
  const taskModel = metadata?.model;
  const taskThinking = metadata?.thinkingLevel;
  let profileId = resolvedProfileId;
  let model = selectedProfile.model;
  let thinkingLevel = selectedProfile.thinkingLevel;
  let phaseModels = providerPreset?.phaseModels ?? selectedProfile.phaseModels ?? DEFAULT_PHASE_MODELS;
  let phaseThinking = providerPreset?.phaseThinking ?? selectedProfile.phaseThinking ?? DEFAULT_PHASE_THINKING;

  if (metadata?.isAutoProfile) {
    profileId = 'auto';
    model = taskModel || selectedProfile.model;
    thinkingLevel = taskThinking || selectedProfile.thinkingLevel;
    phaseModels = metadata.phaseModels || DEFAULT_PHASE_MODELS;
    phaseThinking = metadata.phaseThinking || DEFAULT_PHASE_THINKING;
  } else if (taskModel && taskThinking) {
    const matchingProfile = DEFAULT_AGENT_PROFILES.find(
      p => p.model === taskModel && p.thinkingLevel === taskThinking && !p.isAutoProfile
    );
    profileId = matchingProfile?.id || 'custom';
    model = taskModel;
    thinkingLevel = taskThinking;
    phaseModels = metadata?.phaseModels || DEFAULT_PHASE_MODELS;
    phaseThinking = metadata?.phaseThinking || DEFAULT_PHASE_THINKING;
  }

  return {
    title: task.title,
    description: task.description,
    category: metadata?.category || '',
    priority: metadata?.priority || '',
    complexity: metadata?.complexity || '',
    impact: metadata?.impact || '',
    taskAgent: savedTaskAgent(metadata),
    profileId,
    model,
    thinkingLevel,
    phaseModels,
    phaseThinking,
    images: metadata?.attachedImages || [],
    requireReviewBeforeCoding: metadata?.requireReviewBeforeCoding ?? false,
    fastMode: metadata?.fastMode ?? false,
    taskDependencies: metadata?.taskDependencies || [],
    tokenBudgetText: metadata?.tokenBudget !== undefined ? String(metadata.tokenBudget) : ''
  };
}

function attachmentValues({ id, filename, mimeType, size, path, data }: ImageAttachment) {
  // Thumbnails can be hydrated asynchronously without a user edit.
  return [id, filename, mimeType, size, path, data];
}

function snapshotEditValues(values: EditValues) {
  // Copy primitives only, flattening phase records in a fixed order. Dependencies
  // and attachments retain their form order. Image data is compared, not serialized.
  return {
    fields: [
      values.title.trim(), values.description.trim(),
      values.category, values.priority, values.complexity, values.impact,
      values.profileId, values.model, values.thinkingLevel, values.taskAgent?.mode,
      ...PHASE_KEYS.flatMap(phase => {
        const route = values.taskAgent?.phases[phase];
        return [values.phaseModels?.[phase], values.phaseThinking?.[phase],
          route?.provider, route?.modelId, route?.thinkingLevel];
      }),
      values.requireReviewBeforeCoding, values.fastMode, parseTokenBudgetText(values.tokenBudgetText),
      ...values.taskDependencies
    ],
    attachments: values.images.map(attachmentValues)
  };
}

function sameOrderedValues<T>(first: readonly T[], second: readonly T[]) {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function hasClassification({ category, priority, complexity, impact }: EditValues) {
  return Boolean(category || priority || complexity || impact);
}

function useTaskEditSession(task: Task, open: boolean, settings: AppSettings, activeProvider: BuiltinProvider | null) {
  const startSession = () => {
    const values = initializeEditValues(task, settings, activeProvider);
    return { open, taskId: task.id, projectId: task.projectId, values, baseline: snapshotEditValues(values) };
  };
  const [session, setSession] = useState(startSession);
  const [showClassification, setShowClassification] = useState(() => hasClassification(session.values));
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // Reset before rendering the form for a new session, but never rebase on
  // same-task store or settings changes. Keep values on close for the exit animation.
  if (open && (!session.open || session.taskId !== task.id || session.projectId !== task.projectId)) {
    const nextSession = startSession();
    setSession(nextSession);
    setConfirmDiscard(false);
    setError(null);
    setShowClassification(hasClassification(nextSession.values));
  } else if (!open && session.open) {
    setSession({ ...session, open: false });
    setConfirmDiscard(false);
  }

  const updateValues = useCallback((patch: Partial<EditValues> | ((values: EditValues) => Partial<EditValues>)) => {
    setSession(current => ({
      ...current,
      values: { ...current.values, ...(typeof patch === 'function' ? patch(current.values) : patch) }
    }));
  }, []);

  // Keep separate from Save's comparison against persisted metadata.
  const hasUnsavedEdits = () => {
    const current = snapshotEditValues(session.values);
    return !sameOrderedValues(current.fields, session.baseline.fields) ||
      current.attachments.length !== session.baseline.attachments.length ||
      current.attachments.some((image, index) => !sameOrderedValues(image, session.baseline.attachments[index]));
  };

  return {
    values: session.values, updateValues, hasUnsavedEdits, error, setError,
    showClassification, setShowClassification, confirmDiscard, setConfirmDiscard
  };
}

export function TaskEditDialog({ task, open, onOpenChange, onSaved }: TaskEditDialogProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const { settings } = useSettingsStore();
  const { isAnthropic, provider: activeProvider } = useActiveProvider();
  const {
    values, updateValues, hasUnsavedEdits, error, setError, showClassification,
    setShowClassification, confirmDiscard, setConfirmDiscard
  } = useTaskEditSession(task, open, settings, activeProvider);
  const {
    title, description, category, priority, complexity, impact, taskAgent, profileId, model,
    thinkingLevel, phaseModels, phaseThinking, images, requireReviewBeforeCoding,
    fastMode, taskDependencies, tokenBudgetText
  } = values;
  const [isSaving, setIsSaving] = useState(false);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // Radix restores focus after the alert unmounts. Don't restore into a closed
  // editor or a different task if the edit session ended in the meantime.
  // biome-ignore lint/correctness/useExhaustiveDependencies: open and the task identity are intentional triggers; the cleanup must clear the focus target whenever the edit session changes
  useLayoutEffect(() => () => {
    returnFocusRef.current = null;
  }, [open, task.id, task.projectId]);

  const requestClose = () => {
    if (!open || isSaving || confirmDiscard) return;
    if (!hasUnsavedEdits()) {
      onOpenChange(false);
      return;
    }

    const fallback = cancelButtonRef.current;
    const active = fallback?.ownerDocument.activeElement;
    returnFocusRef.current = active instanceof HTMLElement && fallback?.closest('[role="dialog"]')?.contains(active)
      ? active
      : fallback;
    setConfirmDiscard(true);
  };
  // TaskFormFields uses this callback as a dependency of its thumbnail-loading effect.
  const setImages = useCallback((images: ImageAttachment[]) => updateValues({ images }), [updateValues]);

  // Get project path for loading image thumbnails from disk
  const projects = useProjectStore((state) => state.projects);
  const projectPath = useMemo(() => {
    const project = projects.find(p => p.id === task.projectId);
    return project?.path;
  }, [projects, task.projectId]);

  const allTasks = useTaskStore((state) => state.tasks);
  const projectTasks = useMemo(() => allTasks.filter((x) => x.projectId === task.projectId), [allTasks, task.projectId]);
  const inheritedTokenBudget = projects.find((p) => p.id === task.projectId)?.settings?.tokenBudget;

  // Show Fast Mode toggle when any phase uses an Opus model
  const showFastModeToggle = useMemo(() => {
    if (taskAgent) return Object.values(taskAgent.phases).some(p => p.provider === 'anthropic' && FAST_MODE_MODELS.includes(p.modelId));
    if (!isAnthropic) return false;
    if (!phaseModels) return false;
    return PHASE_KEYS.some(phase => FAST_MODE_MODELS.includes(phaseModels[phase]));
  }, [isAnthropic, phaseModels, taskAgent]);

  // Disable fast mode toggle for tasks that have moved past backlog
  const isFastModeEditable = task.status === 'backlog';

  /**
   * Handle file reference drop from FileTreeItem drag
   * Appends @filename to the end of the description (no textarea ref in edit dialog)
   */
  const handleFileReferenceDrop = useCallback((reference: string, _data: FileReferenceData) => {
    // Append to description using functional update to ensure latest state
    // This prevents stale closure issues with rapid consecutive drops
    updateValues(({ description }) => {
      const separator = description.endsWith(' ') || description === '' ? '' : ' ';
      return { description: description + separator + reference + ' ' };
    });
  }, [updateValues]);

  const handleSave = async () => {
    if (isSaving || confirmDiscard) return;

    // Validate input
    if (!description.trim()) {
      setError(t('tasks:form.errors.descriptionRequired'));
      return;
    }

    // Check if anything changed
    const trimmedTitle = title.trim();
    const trimmedDescription = description.trim();
    // Model/profile selection differs from what the task has saved (also true when the
    // task had none saved, since the dialog then fills in the active provider's defaults).
    // zeenha fork: models and thinking are tracked apart, because only a model change
    // moves the task to the active provider (see `provider` below).
    const modelsChanged =
      model !== (task.metadata?.model || '') ||
      JSON.stringify(phaseModels) !== JSON.stringify(task.metadata?.phaseModels || DEFAULT_PHASE_MODELS);
    const modelSelectionChanged =
      modelsChanged ||
      thinkingLevel !== (task.metadata?.thinkingLevel || '') ||
      JSON.stringify(phaseThinking) !== JSON.stringify(task.metadata?.phaseThinking || DEFAULT_PHASE_THINKING);
    const hasChanges =
      JSON.stringify(taskAgent) !== JSON.stringify(savedTaskAgent(task.metadata)) ||
      trimmedTitle !== task.title ||
      trimmedDescription !== task.description ||
      category !== (task.metadata?.category || '') ||
      priority !== (task.metadata?.priority || '') ||
      complexity !== (task.metadata?.complexity || '') ||
      impact !== (task.metadata?.impact || '') ||
      modelSelectionChanged ||
      requireReviewBeforeCoding !== (task.metadata?.requireReviewBeforeCoding ?? false) ||
      fastMode !== (task.metadata?.fastMode ?? false) ||
      JSON.stringify(taskDependencies) !== JSON.stringify(task.metadata?.taskDependencies || []) ||
      parseTokenBudgetText(tokenBudgetText) !== task.metadata?.tokenBudget ||
      JSON.stringify(images) !== JSON.stringify(task.metadata?.attachedImages || []);

    if (!hasChanges) {
      onOpenChange(false);
      return;
    }

    setIsSaving(true);
    setError(null);

    // Build metadata updates
    const metadataUpdates: Partial<typeof task.metadata> = {};
    if (category) metadataUpdates.category = category;
    if (priority) metadataUpdates.priority = priority;
    if (complexity) metadataUpdates.complexity = complexity;
    if (impact) metadataUpdates.impact = impact;
    if (model) metadataUpdates.model = model as ModelType;
    if (thinkingLevel) metadataUpdates.thinkingLevel = thinkingLevel as ThinkingLevel;
    // zeenha fork: a profile-based task whose models were picked in this dialog takes them
    // from the active provider, so save that provider. Otherwise (including a thinking-only
    // edit) the saved models still belong to the task's own provider, so keep it. A
    // task-agent task keeps its own, and taskPhaseMetadata sets it below.
    const provider = !taskAgent && modelsChanged
      ? activeProvider
      : (task.metadata?.provider ?? activeProvider);
    if (provider) metadataUpdates.provider = provider;
    if (phaseModels && phaseThinking) {
      metadataUpdates.isAutoProfile = profileId === 'auto';
      metadataUpdates.phaseModels = phaseModels;
      metadataUpdates.phaseThinking = phaseThinking;
    }
    if (taskAgent) Object.assign(metadataUpdates, taskPhaseMetadata(taskAgent.phases), { taskAgentMode: taskAgent.mode });
    // Always set attachedImages to persist removal when all images are deleted
    metadataUpdates.attachedImages = images.length > 0 ? images : [];
    metadataUpdates.requireReviewBeforeCoding = requireReviewBeforeCoding;
    metadataUpdates.fastMode = fastMode && (!taskAgent || showFastModeToggle);
    metadataUpdates.taskDependencies = taskDependencies;
    // undefined clears the override so the task inherits the project default
    metadataUpdates.tokenBudget = parseTokenBudgetText(tokenBudgetText);

    const success = await persistUpdateTask(task.id, {
      title: trimmedTitle,
      description: trimmedDescription,
      metadata: metadataUpdates
    });

    if (success) {
      onOpenChange(false);
      onSaved?.();
    } else {
      setError(mapDependencyError(useTaskStore.getState().error, t) ?? t('tasks:edit.errors.updateFailed'));
    }

    setIsSaving(false);
  };

  const isValid = description.trim().length > 0;

  return (
    <>
      <TaskModalLayout
        open={open}
        onOpenChange={requestClose}
        title={t('tasks:edit.title')}
        description={t('tasks:edit.description')}
        disabled={isSaving}
        footer={
          <div className="flex items-center justify-end gap-3">
            <Button ref={cancelButtonRef} variant="outline" onClick={requestClose} disabled={isSaving}>
              {t('common:buttons.cancel')}
            </Button>
            <Button onClick={handleSave} disabled={isSaving || !isValid}>
              {isSaving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('common:buttons.saving')}
                </>
              ) : (
                t('tasks:edit.saveChanges')
              )}
            </Button>
          </div>
        }
      >
        <TaskFormFields
          taskAgent={taskAgent}
          onTaskAgentChange={(taskAgent) => updateValues({ taskAgent })}
          allowConfiguredProfile={!task.metadata?.taskAgentMode}
          projectPath={projectPath}
          specId={task.specId}
          description={description}
          onDescriptionChange={(description) => updateValues({ description })}
          title={title}
          onTitleChange={(title) => updateValues({ title })}
          profileId={profileId}
          model={model}
          thinkingLevel={thinkingLevel}
          phaseModels={phaseModels}
          phaseThinking={phaseThinking}
          onProfileChange={(profileId, model, thinkingLevel) => updateValues({ profileId, model, thinkingLevel })}
          onModelChange={(model) => updateValues({ model })}
          onThinkingLevelChange={(thinkingLevel) => updateValues({ thinkingLevel })}
          onPhaseModelsChange={(phaseModels) => updateValues({ phaseModels })}
          onPhaseThinkingChange={(phaseThinking) => updateValues({ phaseThinking })}
          category={category}
          priority={priority}
          complexity={complexity}
          impact={impact}
          onCategoryChange={(category) => updateValues({ category })}
          onPriorityChange={(priority) => updateValues({ priority })}
          onComplexityChange={(complexity) => updateValues({ complexity })}
          onImpactChange={(impact) => updateValues({ impact })}
          showClassification={showClassification}
          onShowClassificationChange={setShowClassification}
          images={images}
          onImagesChange={setImages}
          requireReviewBeforeCoding={requireReviewBeforeCoding}
          onRequireReviewChange={(requireReviewBeforeCoding) => updateValues({ requireReviewBeforeCoding })}
          fastMode={fastMode}
          onFastModeChange={(fastMode) => updateValues({ fastMode })}
          showFastModeToggle={showFastModeToggle && isFastModeEditable}
          tokenBudgetText={tokenBudgetText}
          onTokenBudgetTextChange={(tokenBudgetText) => updateValues({ tokenBudgetText })}
          inheritedTokenBudget={inheritedTokenBudget}
          disabled={isSaving}
          error={error}
          onError={setError}
          onFileReferenceDrop={handleFileReferenceDrop}
          idPrefix="edit"
        />
        <TaskDependencyPicker
          value={taskDependencies}
          onChange={(taskDependencies) => updateValues({ taskDependencies })}
          tasks={projectTasks}
          excludeTaskId={task.id}
          disabled={isSaving}
          idPrefix="edit"
        />
      </TaskModalLayout>
      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setConfirmDiscard(false);
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = returnFocusRef.current;
            returnFocusRef.current = null;
            if (!target) return;
            if (target.isConnected) target.focus({ preventScroll: true });
            if (target.ownerDocument.activeElement !== target) {
              cancelButtonRef.current?.focus({ preventScroll: true });
            }
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{t('tasks:edit.discardDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('tasks:edit.discardDialog.description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('tasks:edit.discardDialog.keepEditing')}</AlertDialogCancel>
            {/* Not asChild + <Button variant="destructive">: AlertDialogAction's default
                buttonVariants() classes would be merged last and win, rendering primary. */}
            <AlertDialogAction
              className={buttonVariants({ variant: 'destructive' })}
              onClick={(event) => {
                event.preventDefault();
                returnFocusRef.current = null;
                setConfirmDiscard(false);
                onOpenChange(false);
              }}
            >
              {t('tasks:edit.discardDialog.discardEdits')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
