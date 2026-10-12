/**
 * @vitest-environment jsdom
 *
 * zeenha fork: the detail panel of a task that failed before any work: the
 * reason, Retry and Re-plan.
 */
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
const retryFailedTask = vi.fn();
const replanFailedTask = vi.fn();
vi.mock('../../../stores/task-store', () => ({
  retryFailedTask: (...a: unknown[]) => retryFailedTask(...a),
  replanFailedTask: (...a: unknown[]) => replanFailedTask(...a),
}));

import { FailedTaskPanel } from '../FailedTaskPanel';

const subtask = { id: 's1', title: '', description: '', status: 'pending', files: [] };
const task = (o: Record<string, unknown> = {}) =>
  ({ id: 't1', status: 'error', subtasks: [subtask], ...o }) as never;

beforeEach(() => {
  retryFailedTask.mockReset().mockResolvedValue({ success: true, action: 'started' });
  replanFailedTask.mockReset().mockResolvedValue({ success: true, action: 'started' });
});

describe('FailedTaskPanel', () => {
  it('shows the recorded reason', () => {
    render(<FailedTaskPanel task={task({ failureReason: 'Plan validation failed' })} />);
    expect(screen.getByTestId('failed-task-reason')).toHaveTextContent('Plan validation failed');
  });

  it('says no reason was recorded when there is none', () => {
    render(<FailedTaskPanel task={task()} />);
    expect(screen.getByTestId('failed-task-reason')).toHaveTextContent('tasks:failedTask.noReason');
  });

  it('Retry continues the task', async () => {
    render(<FailedTaskPanel task={task()} />);
    await act(async () => fireEvent.click(screen.getByTestId('failed-task-retry')));
    expect(retryFailedTask).toHaveBeenCalledWith('t1');
    expect(replanFailedTask).not.toHaveBeenCalled();
  });

  it('Re-plan discards the plan and plans again', async () => {
    render(<FailedTaskPanel task={task()} />);
    await act(async () => fireEvent.click(screen.getByTestId('failed-task-replan')));
    expect(replanFailedTask).toHaveBeenCalledWith('t1');
    expect(retryFailedTask).not.toHaveBeenCalled();
  });

  it('offers no Re-plan when there is no plan to discard', () => {
    render(<FailedTaskPanel task={task({ subtasks: [] })} />);
    expect(screen.queryByTestId('failed-task-replan')).not.toBeInTheDocument();
    expect(screen.getByTestId('failed-task-retry')).toBeInTheDocument();
  });

  it('shows why a start failed', async () => {
    retryFailedTask.mockResolvedValue({ success: false, action: 'started', error: 'no auth' });
    render(<FailedTaskPanel task={task()} />);
    await act(async () => fireEvent.click(screen.getByTestId('failed-task-retry')));
    expect(screen.getByText('no auth')).toBeInTheDocument();
  });

  it('offers no Create PR', () => {
    render(<FailedTaskPanel task={task()} />);
    expect(screen.queryByText(/pull request|Create PR/i)).not.toBeInTheDocument();
  });
});
