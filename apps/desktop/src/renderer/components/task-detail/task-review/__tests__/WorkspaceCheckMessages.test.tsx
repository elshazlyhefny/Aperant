/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Task } from '../../../../../shared/types';
import { StagedSuccessMessage } from '../StagedSuccessMessage';
import { DiffCheckErrorMessage, StagedInProjectMessage, WorkspaceCheckErrorMessage } from '../WorkspaceMessages';
import { WorkspaceStatus } from '../WorkspaceStatus';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('../../../../stores/task-store', () => ({
  persistTaskStatus: vi.fn(),
  startTaskOrQueue: vi.fn(),
}));
vi.mock('../../../../stores/settings-store', () => ({
  useSettingsStore: () => ({ settings: {} }),
}));

const task: Task = {
  id: 't1',
  specId: '001-task',
  projectId: 'p1',
  title: 'Test task',
  description: '',
  status: 'human_review',
  subtasks: [],
  logs: [],
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const stagedProps = { task, onReviewAgain: vi.fn() };
const successProps = {
  ...stagedProps,
  stagedSuccess: 'Staged 3 files',
  suggestedCommitMessage: 'Update files',
};

const actionsUnavailable = 'taskReview:workspaceCheck.actionsUnavailable';

describe('Workspace check error messages', () => {
  it('shows status failure details and disables Retry while retrying', () => {
    const onRetry = vi.fn();
    const props = { error: 'Status check timed out', onRetry };
    const { rerender } = render(<WorkspaceCheckErrorMessage {...props} isRetrying={false} />);

    expect(screen.getByRole('heading', { name: 'taskReview:workspaceCheck.statusFailedTitle' })).toBeInTheDocument();
    expect(screen.getByText('taskReview:workspaceCheck.statusFailedDescription')).toBeInTheDocument();
    expect(screen.getByText(props.error)).toBeInTheDocument();
    const retry = screen.getByTestId('retry-workspace-status');
    expect(retry).toHaveAccessibleName('common:buttons.retry');
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(<WorkspaceCheckErrorMessage {...props} isRetrying />);
    expect(retry).toBeDisabled();
    expect(retry).toHaveAccessibleName('taskReview:workspaceCheck.retrying');
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows changed-files failure and retries the diff', () => {
    const onRetry = vi.fn();
    render(<DiffCheckErrorMessage error={null} isRetrying={false} onRetry={onRetry} />);

    expect(screen.getByRole('heading', { name: 'taskReview:workspaceCheck.diffFailedTitle' })).toBeInTheDocument();
    expect(screen.getByText('taskReview:workspaceCheck.diffFailedDescription')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('retry-workspace-diff'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('Staged workspace actions', () => {
  it.each([false, true])('keeps staged and commit details without unverified actions (hasWorktree=%s)', (hasWorktree) => {
    render(<StagedSuccessMessage {...successProps} hasWorktree={hasWorktree} isWorktreeVerified={false} />);

    expect(screen.getByText('taskReview:stagedSuccess.title')).toBeInTheDocument();
    expect(screen.getByText(successProps.stagedSuccess)).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue(successProps.suggestedCommitMessage);
    expect(screen.getByText('taskReview:stagedSuccess.nextSteps')).toBeInTheDocument();
    expect(screen.getByText(actionsUnavailable)).toBeInTheDocument();
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['taskReview:stagedSuccess.copy']);
  });

  it.each([false, true])('keeps staged-in-project details without unverified actions (hasWorktree=%s)', (hasWorktree) => {
    render(<StagedInProjectMessage {...stagedProps} hasWorktree={hasWorktree} isWorktreeVerified={false} />);

    expect(screen.getByText('Changes Staged in Project')).toBeInTheDocument();
    expect(screen.getByText('Next steps:')).toBeInTheDocument();
    expect(screen.getByText(actionsUnavailable)).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it.each([false, true])('preserves staged-success actions by default (hasWorktree=%s)', (hasWorktree) => {
    render(<StagedSuccessMessage {...stagedProps} stagedSuccess="Staged changes" hasWorktree={hasWorktree} />);

    expect(screen.queryByText(actionsUnavailable)).not.toBeInTheDocument();
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(hasWorktree
      ? ['deleteWorktreeAndMarkDone', 'markDoneOnly', 'reviewAgain'].map((action) => `taskReview:stagedSuccess.${action}`)
      : ['taskReview:stagedSuccess.markAsDone']);
  });

  it.each([false, true])('preserves staged-in-project actions by default (hasWorktree=%s)', (hasWorktree) => {
    render(<StagedInProjectMessage {...stagedProps} hasWorktree={hasWorktree} />);

    expect(screen.queryByText(actionsUnavailable)).not.toBeInTheDocument();
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(hasWorktree
      ? ['Delete Worktree & Mark Done', 'Mark Done Only', 'Review Again']
      : ['Mark as Done']);
  });
});

describe('WorkspaceStatus changed files', () => {
  it('keeps status details visible and only enables View after the diff succeeds', () => {
    const props = {
      taskId: task.id,
      worktreeStatus: { exists: true, worktreePath: '/worktree', branch: 'task-branch', filesChanged: 3 },
      workspaceError: null,
      stageOnly: false,
      mergePreview: null,
      isLoadingPreview: false,
      isMerging: false,
      isDiscarding: false,
      onShowDiffDialog: vi.fn(),
      onShowDiscardDialog: vi.fn(),
      onShowConflictDialog: vi.fn(),
      onLoadMergePreview: vi.fn(),
      onStageOnlyChange: vi.fn(),
      onMerge: vi.fn(),
      onRetryDiff: vi.fn(),
    };
    const { rerender } = render(<WorkspaceStatus {...props} diffCheckState="idle" />);
    expect(screen.getByRole('button', { name: 'View' })).toBeDisabled();

    rerender(<WorkspaceStatus {...props} diffCheckState="error" diffError="Diff check timed out" />);
    expect(screen.getByRole('button', { name: 'View' })).toBeDisabled();
    expect(screen.getByText('Diff check timed out')).toBeInTheDocument();
    expect(screen.getByText('task-branch')).toBeInTheDocument();
    expect(screen.getByText(/\/worktree/)).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open in VS Code' })).toBeEnabled();
    fireEvent.click(screen.getByTestId('retry-workspace-diff'));
    expect(props.onRetryDiff).toHaveBeenCalledTimes(1);

    rerender(<WorkspaceStatus {...props} diffCheckState="loading" />);
    const label = 'taskReview:workspaceCheck.loadingChangedFiles';
    const loadingView = screen.getByRole('button', { name: label });
    expect(loadingView).toBeDisabled();
    expect(loadingView).toHaveAttribute('title', label);
    expect(screen.queryByTestId('retry-workspace-diff')).not.toBeInTheDocument();

    rerender(<WorkspaceStatus {...props} diffCheckState="success" />);
    const view = screen.getByRole('button', { name: 'View' });
    expect(view).toBeEnabled();
    fireEvent.click(view);
    expect(props.onShowDiffDialog).toHaveBeenCalledExactlyOnceWith(true);
  });
});
