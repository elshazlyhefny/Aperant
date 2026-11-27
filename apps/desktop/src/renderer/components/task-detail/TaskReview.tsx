import type { Task, WorktreeStatus, WorktreeDiff, MergeConflict, MergeStats, GitConflictInfo, ImageAttachment, WorktreeCreatePRResult } from '../../../shared/types';
import type { WorkspaceCheckState } from './hooks/useTaskDetail';
import {
  StagedSuccessMessage,
  WorkspaceStatus,
  QAFeedbackSection,
  DiscardDialog,
  DiffViewDialog,
  ConflictDetailsDialog,
  LoadingMessage,
  NoWorkspaceMessage,
  StagedInProjectMessage,
  WorkspaceCheckErrorMessage,
  CreatePRDialog
} from './task-review';

type WorkspaceCheck = { state: WorkspaceCheckState; error: string | null };

interface TaskReviewProps {
  task: Task;
  feedback: string;
  isSubmitting: boolean;
  worktreeStatus: WorktreeStatus | null;
  worktreeDiff: WorktreeDiff | null;
  worktreeStatusCheck: WorkspaceCheck;
  worktreeDiffCheck: WorkspaceCheck;
  isLoadingWorktree: boolean;
  isMerging: boolean;
  isDiscarding: boolean;
  showDiscardDialog: boolean;
  showDiffDialog: boolean;
  workspaceError: string | null;
  stageOnly: boolean;
  stagedSuccess: string | null;
  stagedProjectPath: string | undefined;
  suggestedCommitMessage: string | undefined;
  mergePreview: { files: string[]; conflicts: MergeConflict[]; summary: MergeStats; gitConflicts?: GitConflictInfo; uncommittedChanges?: { hasChanges: boolean; files: string[]; count: number } | null } | null;
  isLoadingPreview: boolean;
  showConflictDialog: boolean;
  onFeedbackChange: (value: string) => void;
  onReject: () => void;
  /** Image attachments for visual feedback */
  images?: ImageAttachment[];
  /** Callback when images change */
  onImagesChange?: (images: ImageAttachment[]) => void;
  onMerge: () => void;
  onDiscard: () => void;
  onShowDiscardDialog: (show: boolean) => void;
  onShowDiffDialog: (show: boolean) => void;
  onStageOnlyChange: (value: boolean) => void;
  onShowConflictDialog: (show: boolean) => void;
  onLoadMergePreview: () => void;
  onRetryWorktreeStatus: () => void;
  onRetryWorktreeDiff: () => void;
  onClose?: () => void;
  onSwitchToTerminals?: () => void;
  onOpenInbuiltTerminal?: (id: string, cwd: string) => void;
  onReviewAgain?: () => void;
  // PR creation
  showPRDialog: boolean;
  isCreatingPR: boolean;
  onShowPRDialog: (show: boolean) => void;
  onCreatePR: (options: { targetBranch?: string; title?: string; draft?: boolean }) => Promise<WorktreeCreatePRResult | null>;
}

/**
 * TaskReview Component
 *
 * Main component for reviewing task completion, displaying workspace status,
 * merge previews, and providing options to merge, stage, or discard changes.
 *
 * This component has been refactored into smaller, focused sub-components for better
 * maintainability. See ./task-review/ directory for individual component implementations.
 */
export function TaskReview({
  task,
  feedback,
  isSubmitting,
  worktreeStatus,
  worktreeDiff,
  worktreeStatusCheck,
  worktreeDiffCheck,
  isLoadingWorktree,
  isMerging,
  isDiscarding,
  showDiscardDialog,
  showDiffDialog,
  workspaceError,
  stageOnly,
  stagedSuccess,
  stagedProjectPath,
  suggestedCommitMessage,
  mergePreview,
  isLoadingPreview,
  showConflictDialog,
  onFeedbackChange,
  onReject,
  images,
  onImagesChange,
  onMerge,
  onDiscard,
  onShowDiscardDialog,
  onShowDiffDialog,
  onStageOnlyChange,
  onShowConflictDialog,
  onLoadMergePreview,
  onRetryWorktreeStatus,
  onRetryWorktreeDiff,
  onClose,
  onSwitchToTerminals,
  onOpenInbuiltTerminal,
  onReviewAgain,
  showPRDialog,
  isCreatingPR,
  onShowPRDialog,
  onCreatePR
}: TaskReviewProps) {
  const statusVerified = worktreeStatusCheck.state === 'success';
  const hasWorktree = statusVerified && worktreeStatus?.exists === true;
  const statusError = worktreeStatusCheck.state === 'error' ? (
    <WorkspaceCheckErrorMessage
      error={worktreeStatusCheck.error}
      isRetrying={false}
      onRetry={onRetryWorktreeStatus}
    />
  ) : null;

  return (
    <div className="space-y-4">
      {/* Section divider */}
      <div className="section-divider-gradient" />

      {/* zeenha fork: a failed status check is not proof of absence; only verified status enables workspace actions. */}
      {isLoadingWorktree ? (
        <LoadingMessage />
      ) : stagedSuccess ? (
        <>
          {statusError}
          <StagedSuccessMessage
            stagedSuccess={stagedSuccess}
            suggestedCommitMessage={suggestedCommitMessage}
            task={task}
            hasWorktree={hasWorktree}
            isWorktreeVerified={statusVerified}
            projectPath={stagedProjectPath}
            onClose={onClose}
            onReviewAgain={onReviewAgain}
          />
        </>
      ) : task.stagedInMainProject ? (
        <>
          {statusError}
          <StagedInProjectMessage
            task={task}
            projectPath={stagedProjectPath}
            hasWorktree={hasWorktree}
            isWorktreeVerified={statusVerified}
            onClose={onClose}
            onReviewAgain={onReviewAgain}
          />
        </>
      ) : statusError ? (
        statusError
      ) : hasWorktree ? (
        <WorkspaceStatus
          taskId={task.id}
          worktreeStatus={worktreeStatus}
          diffCheckState={worktreeDiffCheck.state}
          diffError={worktreeDiffCheck.error}
          onRetryDiff={onRetryWorktreeDiff}
          workspaceError={workspaceError}
          stageOnly={stageOnly}
          mergePreview={mergePreview}
          isLoadingPreview={isLoadingPreview}
          isMerging={isMerging}
          isDiscarding={isDiscarding}
          isCreatingPR={isCreatingPR}
          onShowDiffDialog={onShowDiffDialog}
          onShowDiscardDialog={onShowDiscardDialog}
          onShowConflictDialog={onShowConflictDialog}
          onLoadMergePreview={onLoadMergePreview}
          onStageOnlyChange={onStageOnlyChange}
          onMerge={onMerge}
          onShowPRDialog={onShowPRDialog}
          onClose={onClose}
          onSwitchToTerminals={onSwitchToTerminals}
          onOpenInbuiltTerminal={onOpenInbuiltTerminal}
        />
      ) : statusVerified && worktreeStatus?.exists === false ? (
        <NoWorkspaceMessage task={task} onClose={onClose} />
      ) : (
        <LoadingMessage />
      )}

      {/* QA Feedback Section */}
      <QAFeedbackSection
        feedback={feedback}
        isSubmitting={isSubmitting}
        onFeedbackChange={onFeedbackChange}
        onReject={onReject}
        images={images}
        onImagesChange={onImagesChange}
      />

      {/* Discard Confirmation Dialog */}
      <DiscardDialog
        open={showDiscardDialog}
        task={task}
        worktreeStatus={worktreeStatus}
        isDiscarding={isDiscarding}
        onOpenChange={onShowDiscardDialog}
        onDiscard={onDiscard}
      />

      {/* Diff View Dialog */}
      <DiffViewDialog
        open={showDiffDialog && worktreeDiffCheck.state === 'success'}
        worktreeDiff={worktreeDiff}
        onOpenChange={onShowDiffDialog}
      />

      {/* Conflict Details Dialog */}
      <ConflictDetailsDialog
        open={showConflictDialog}
        mergePreview={mergePreview}
        stageOnly={stageOnly}
        onOpenChange={onShowConflictDialog}
        onMerge={onMerge}
      />

      {/* Create PR Dialog */}
      <CreatePRDialog
        open={showPRDialog}
        task={task}
        worktreeStatus={worktreeStatus}
        onOpenChange={onShowPRDialog}
        onCreatePR={onCreatePR}
      />
    </div>
  );
}
