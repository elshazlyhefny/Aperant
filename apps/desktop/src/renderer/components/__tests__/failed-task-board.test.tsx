/**
 * @vitest-environment jsdom
 *
 * zeenha fork: a task that failed before any work sits in its own Failed
 * column, shows why on its card, and offers Retry / Re-plan.
 */
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
const retryFailedTask = vi.fn();
const replanFailedTask = vi.fn();
vi.mock('../../stores/task-store', () => ({
  useTaskStore: (selector: (s: { tasks: unknown[] }) => unknown) => selector({ tasks: [] }),
  retryFailedTask: (...a: unknown[]) => retryFailedTask(...a),
  replanFailedTask: (...a: unknown[]) => replanFailedTask(...a),
  startTaskOrQueue: vi.fn(),
  stopTask: vi.fn(),
  checkTaskRunning: vi.fn(),
  recoverStuckTask: vi.fn(),
  archiveTasks: vi.fn(),
  hasRecentActivity: vi.fn(() => false),
  isIncompleteHumanReview: (task: { status: string; reviewReason?: string; subtasks: Array<{ status: string }> }) =>
    task.status === 'human_review' && !task.reviewReason && !task.subtasks.some((s) => s.status === 'completed'),
}));
vi.mock('../PhaseProgressIndicator', () => ({ PhaseProgressIndicator: () => null }));
vi.mock('../../hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { TaskCard } from '../TaskCard';
import { FAILED_COLUMN, getBoardColumns, getVisualColumn } from '../kanban-columns';

const subtask = { id: 's1', title: '', description: '', status: 'pending', files: [] };
const task = (o: Record<string, unknown> = {}) =>
  ({
    id: 't1',
    specId: '025-x',
    projectId: 'p1',
    title: 'Failed task',
    description: 'desc',
    status: 'error',
    subtasks: [subtask],
    logs: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...o,
  }) as never;

beforeEach(() => {
  retryFailedTask.mockReset().mockResolvedValue({ success: true, action: 'started' });
  replanFailedTask.mockReset().mockResolvedValue({ success: true, action: 'started' });
});

describe('board columns', () => {
  it('puts a failed task in the Failed column, not Human Review', () => {
    expect(getVisualColumn('error')).toBe(FAILED_COLUMN);
    expect(getVisualColumn('human_review')).toBe('human_review');
    expect(getVisualColumn('pr_created')).toBe('done');
  });

  it('shows the Failed column after Human Review only while it holds a task', () => {
    expect(getBoardColumns(0)).not.toContain(FAILED_COLUMN);
    const columns = getBoardColumns(2);
    expect(columns.indexOf(FAILED_COLUMN)).toBe(columns.indexOf('human_review') + 1);
  });
});

describe('TaskCard for a failed task', () => {
  it('shows the Failed status and the reason, not Has Errors', () => {
    render(<TaskCard task={task({ failureReason: 'Plan validation failed' })} onClick={() => {}} />);
    expect(screen.getByText('labels.failed')).toBeInTheDocument();
    expect(screen.getByTestId('task-card-failure-reason')).toHaveTextContent('Plan validation failed');
    expect(screen.queryByText('reviewReason.hasErrors')).not.toBeInTheDocument();
  });

  it('says no reason was recorded when there is none', () => {
    render(<TaskCard task={task()} onClick={() => {}} />);
    expect(screen.getByTestId('task-card-failure-reason')).toHaveTextContent('failedTask.noReason');
  });

  it('Retry on the card continues the task without opening it', async () => {
    const onClick = vi.fn();
    render(<TaskCard task={task()} onClick={onClick} />);
    await act(async () => fireEvent.click(screen.getByTestId('task-card-retry')));
    expect(retryFailedTask).toHaveBeenCalledWith('t1');
    expect(onClick).not.toHaveBeenCalled();
  });

  it('a Human Review task with errors after real work keeps its badge and has no Retry', () => {
    render(
      <TaskCard
        task={task({ status: 'human_review', reviewReason: 'errors', subtasks: [{ ...subtask, status: 'completed' }] })}
        onClick={() => {}}
      />
    );
    expect(screen.getByText('reviewReason.hasErrors')).toBeInTheDocument();
    expect(screen.queryByTestId('task-card-retry')).not.toBeInTheDocument();
    expect(screen.queryByTestId('task-card-failure-reason')).not.toBeInTheDocument();
  });
});
