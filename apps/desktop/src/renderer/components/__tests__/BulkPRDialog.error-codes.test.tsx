/**
 * @vitest-environment jsdom
 *
 * zeenha fork: the bulk PR dialog classifies failures by error code, never by
 * matching message text.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('../../stores/task-store', () => ({
  useTaskStore: { getState: () => ({ updateTask: vi.fn() }) },
}));

import { WORKTREE_CREATE_PR_ERROR_CODES } from '../../../shared/types';
import type { WorktreeCreatePRErrorCode } from '../../../shared/types';
import { BulkPRDialog } from '../BulkPRDialog';
import { getBulkPRErrorMessageKey } from '../bulk-pr-errors';

const SKIPPED: WorktreeCreatePRErrorCode[] = ['NO_WORKTREE', 'TASK_NOT_FOUND', 'SPEC_DIR_NOT_FOUND'];

const createWorktreePR = vi.fn();

const task = { id: 't1', specId: '001-x', projectId: 'p1', title: 'My task', metadata: {} } as never;

async function runDialog() {
  const { rerender } = render(<BulkPRDialog open={false} tasks={[task]} onOpenChange={() => {}} />);
  rerender(<BulkPRDialog open tasks={[task]} onOpenChange={() => {}} />);
  fireEvent.click(await screen.findByText('taskReview:bulkPR.createAll'));
  await screen.findByText('common:buttons.close');
}

beforeEach(() => {
  createWorktreePR.mockReset();
  (window as unknown as { electronAPI: unknown }).electronAPI = { createWorktreePR };
});

afterEach(() => cleanup());

describe('BulkPRDialog error codes', () => {
  it.each(WORKTREE_CREATE_PR_ERROR_CODES)('handles %s', async (code) => {
    createWorktreePR.mockResolvedValue({
      success: true,
      data: { success: false, errorCode: code, error: 'server detail' },
    });
    await runDialog();

    const key = getBulkPRErrorMessageKey(code);
    expect(screen.getByText(key ?? 'server detail')).toBeInTheDocument();
    if (SKIPPED.includes(code)) {
      expect(screen.getByText('1 taskReview:bulkPR.skipped')).toBeInTheDocument();
      expect(screen.queryByText('1 taskReview:bulkPR.failed')).not.toBeInTheDocument();
    } else {
      expect(screen.getByText('1 taskReview:bulkPR.failed')).toBeInTheDocument();
      expect(screen.queryByText('1 taskReview:bulkPR.skipped')).not.toBeInTheDocument();
    }
  });

  it('treats the old "no worktree" text without a code as an error', async () => {
    createWorktreePR.mockResolvedValue({ success: false, error: 'No worktree found for this task' });
    await runDialog();
    expect(screen.getByText('No worktree found for this task')).toBeInTheDocument();
    expect(screen.getByText('1 taskReview:bulkPR.failed')).toBeInTheDocument();
    expect(screen.queryByText('1 taskReview:bulkPR.skipped')).not.toBeInTheDocument();
  });

  it('shows an unknown error string that has no code', async () => {
    createWorktreePR.mockResolvedValue({ success: false, error: 'Something odd happened' });
    await runDialog();
    expect(screen.getByText('Something odd happened')).toBeInTheDocument();
    expect(screen.getByText('1 taskReview:bulkPR.failed')).toBeInTheDocument();
  });

  it('shows the unknown message when the error is empty', async () => {
    createWorktreePR.mockResolvedValue({ success: false, error: '' });
    await runDialog();
    expect(screen.getByText('taskReview:pr.errors.unknown')).toBeInTheDocument();
    expect(screen.getByText('1 taskReview:bulkPR.failed')).toBeInTheDocument();
  });

  it('shows a thrown exception message as an error', async () => {
    createWorktreePR.mockRejectedValue(new Error('IPC exploded'));
    await runDialog();
    expect(screen.getByText('IPC exploded')).toBeInTheDocument();
    expect(screen.getByText('1 taskReview:bulkPR.failed')).toBeInTheDocument();
    await waitFor(() => expect(createWorktreePR).toHaveBeenCalledTimes(1));
  });
});
