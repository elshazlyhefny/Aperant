/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../../../shared/types';
import { TaskReview } from '../TaskReview';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('../../../stores/task-store', () => ({
  persistTaskStatus: vi.fn(),
  startTaskOrQueue: vi.fn(),
}));
vi.mock('../../../stores/settings-store', () => ({
  useSettingsStore: () => ({ settings: {} }),
}));

const task: Task = {
  id: 't1',
  specId: '001-task',
  projectId: 'p1',
  title: 'Test task',
  description: '',
  status: 'human_review',
  reviewReason: 'completed',
  subtasks: [],
  logs: [],
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const existingWorktree = { exists: true, worktreePath: '/worktree', branch: 'task/example', filesChanged: 1 };
const successfulCheck = { state: 'success', error: null } as const;
const statusFailure = { state: 'error', error: 'Status check failed' } as const;

function reviewProps(overrides: Partial<ComponentProps<typeof TaskReview>> = {}) {
  return {
    task,
    feedback: '',
    isSubmitting: false,
    worktreeStatus: null,
    worktreeDiff: null,
    worktreeStatusCheck: { state: 'idle', error: null },
    worktreeDiffCheck: { state: 'idle', error: null },
    isLoadingWorktree: false,
    isMerging: false,
    isDiscarding: false,
    showDiscardDialog: false,
    showDiffDialog: false,
    workspaceError: null,
    stageOnly: false,
    stagedSuccess: null,
    stagedProjectPath: undefined,
    suggestedCommitMessage: undefined,
    mergePreview: null,
    isLoadingPreview: false,
    showConflictDialog: false,
    onFeedbackChange: vi.fn(),
    onReject: vi.fn(),
    onMerge: vi.fn(),
    onDiscard: vi.fn(),
    onShowDiscardDialog: vi.fn(),
    onShowDiffDialog: vi.fn(),
    onStageOnlyChange: vi.fn(),
    onShowConflictDialog: vi.fn(),
    onLoadMergePreview: vi.fn(),
    onRetryWorktreeStatus: vi.fn(),
    onRetryWorktreeDiff: vi.fn(),
    onReviewAgain: vi.fn(),
    showPRDialog: false,
    isCreatingPR: false,
    onShowPRDialog: vi.fn(),
    onCreatePR: vi.fn().mockResolvedValue(null),
    ...overrides,
  } satisfies ComponentProps<typeof TaskReview>;
}

describe('TaskReview workspace checks', () => {
  beforeEach(() => {
    vi.stubGlobal('electronAPI', { onMergeProgress: vi.fn(() => () => {}) });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the no-workspace flow only after confirmed absence and hides the expected diff error', () => {
    render(<TaskReview {...reviewProps({
      worktreeStatus: { exists: false },
      worktreeStatusCheck: successfulCheck,
      worktreeDiffCheck: { state: 'error', error: 'No worktree found for this task' },
    })} />);

    expect(screen.getByRole('heading', { name: 'No Workspace Found' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark as Done' })).toBeInTheDocument();
    expect(screen.queryByTestId('retry-workspace-status')).not.toBeInTheDocument();
    expect(screen.queryByTestId('retry-workspace-diff')).not.toBeInTheDocument();
  });

  it('offers a status retry, not the no-workspace flow, when the status check fails', () => {
    const props = reviewProps({ worktreeStatusCheck: statusFailure });
    render(<TaskReview {...props} />);

    expect(screen.getByText(statusFailure.error)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'No Workspace Found' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark as Done' })).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('feedback.placeholder')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('retry-workspace-status'));
    expect(props.onRetryWorktreeStatus).toHaveBeenCalledTimes(1);
    expect(props.onRetryWorktreeDiff).not.toHaveBeenCalled();
  });

  it('withholds workspace actions when a failed check leaves behind a previously verified status', () => {
    const props = reviewProps({ worktreeStatus: existingWorktree, worktreeStatusCheck: successfulCheck });
    const { rerender } = render(<TaskReview {...props} />);
    expect(screen.getByRole('heading', { name: 'Build Ready for Review' })).toBeInTheDocument();

    rerender(<TaskReview {...props} worktreeStatusCheck={statusFailure} />);
    expect(screen.getByTestId('retry-workspace-status')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Build Ready for Review' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open in VS Code' })).not.toBeInTheDocument();
  });

  it('offers a diff retry while preserving verified status and blocks the dialog until the diff succeeds', () => {
    const props = reviewProps({
      worktreeStatus: existingWorktree,
      worktreeStatusCheck: successfulCheck,
      worktreeDiffCheck: { state: 'error', error: 'Git diff failed' },
      showDiffDialog: true,
    });
    const { rerender } = render(<TaskReview {...props} />);

    expect(screen.getByRole('heading', { name: 'Build Ready for Review' })).toBeInTheDocument();
    expect(screen.getByText(existingWorktree.branch)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View' })).toBeDisabled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('retry-workspace-diff'));
    expect(props.onRetryWorktreeDiff).toHaveBeenCalledTimes(1);
    expect(props.onRetryWorktreeStatus).not.toHaveBeenCalled();

    rerender(<TaskReview {...props} worktreeDiffCheck={successfulCheck} worktreeDiff={{
      files: [{ path: 'changed.ts', status: 'modified', additions: 1, deletions: 0 }],
      summary: '1 file changed',
    }} />);
    expect(screen.getByRole('alertdialog', { name: 'Changed Files' })).toBeInTheDocument();
    expect(screen.getByText('changed.ts')).toBeInTheDocument();
  });

  it('shows the loading message instead of assuming absence before a result', () => {
    render(<TaskReview {...reviewProps()} />);

    expect(screen.getByText('Loading workspace info...')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'No Workspace Found' })).not.toBeInTheDocument();
  });

  it.each([
    { stagedSuccess: null, heading: 'Changes Staged in Project' },
    { stagedSuccess: 'Staged 1 file', heading: 'taskReview:stagedSuccess.title' },
  ])('keeps $heading visible with a status error and no completion actions', ({ stagedSuccess, heading }) => {
    render(<TaskReview {...reviewProps({
      task: { ...task, stagedInMainProject: true },
      stagedSuccess,
      worktreeStatusCheck: statusFailure,
    })} />);

    expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    expect(screen.getByTestId('retry-workspace-status')).toBeInTheDocument();
    expect(screen.getByText('taskReview:workspaceCheck.actionsUnavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Mark as Done|stagedSuccess\.markAsDone/ })).not.toBeInTheDocument();
  });
});
