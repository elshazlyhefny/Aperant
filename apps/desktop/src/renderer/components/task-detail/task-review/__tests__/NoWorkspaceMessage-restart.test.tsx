/**
 * @vitest-environment jsdom
 *
 * zeenha fork: a task whose spec or planning failed reached Human Review with
 * no plan steps and no workspace, and the panel offered only "Mark as Done",
 * so it could never be run again. It now offers a restart.
 */
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
const startTaskOrQueue = vi.fn();
const persistTaskStatus = vi.fn();
vi.mock('../../../../stores/task-store', () => ({
  startTaskOrQueue: (...a: unknown[]) => startTaskOrQueue(...a),
  persistTaskStatus: (...a: unknown[]) => persistTaskStatus(...a),
}));

import { NoWorkspaceMessage } from '../WorkspaceMessages';

const task = (overrides: Record<string, unknown>) =>
  ({ id: 't1', status: 'human_review', reviewReason: 'errors', subtasks: [], ...overrides }) as never;

beforeEach(() => {
  startTaskOrQueue.mockReset().mockResolvedValue({ success: true, action: 'started' });
  persistTaskStatus.mockReset();
});

describe('NoWorkspaceMessage for a task that failed before any work', () => {
  it('offers Restart (not Mark as Done) and restarts the task', async () => {
    render(<NoWorkspaceMessage task={task({})} />);
    expect(screen.getByText('tasks:restartFailed.title')).toBeInTheDocument();
    expect(screen.queryByText('Mark as Done')).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('restart-failed-task'));
    });
    expect(startTaskOrQueue).toHaveBeenCalledWith('t1');
    expect(persistTaskStatus).not.toHaveBeenCalled();
  });

  it('keeps Mark as Done for a task that has plan steps', () => {
    render(<NoWorkspaceMessage task={task({ subtasks: [{ id: 's1' }] })} />);
    expect(screen.queryByTestId('restart-failed-task')).not.toBeInTheDocument();
    expect(screen.getByText('Mark as Done')).toBeInTheDocument();
  });

  it('keeps Mark as Done for a task that ended without errors', () => {
    render(<NoWorkspaceMessage task={task({ reviewReason: 'completed' })} />);
    expect(screen.queryByTestId('restart-failed-task')).not.toBeInTheDocument();
  });
});
