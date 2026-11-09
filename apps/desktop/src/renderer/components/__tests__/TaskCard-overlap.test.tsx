/**
 * @vitest-environment jsdom
 *
 * zeenha fork: a task card names the other tasks that plan to change the same
 * files, shows when it waits for a task, and shows nothing without overlaps.
 */
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}|${JSON.stringify(opts)}` : key),
    i18n: { language: 'en' },
  }),
}));
vi.mock('../../stores/task-store', () => ({
  retryFailedTask: vi.fn(),
  replanFailedTask: vi.fn(),
  startTaskOrQueue: vi.fn(),
  stopTask: vi.fn(),
  checkTaskRunning: vi.fn(),
  recoverStuckTask: vi.fn(),
  archiveTasks: vi.fn(),
  hasRecentActivity: vi.fn(() => false),
  isIncompleteHumanReview: () => false,
}));
vi.mock('../PhaseProgressIndicator', () => ({ PhaseProgressIndicator: () => null }));
vi.mock('../../hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { TaskCard } from '../TaskCard';

const task = (o: Record<string, unknown> = {}) =>
  ({
    id: 't1', specId: '025-x', projectId: 'p1', title: 'Mine', description: 'desc', status: 'backlog',
    subtasks: [], logs: [], createdAt: new Date(), updatedAt: new Date(), ...o,
  }) as never;

describe('TaskCard overlap badge', () => {
  it('names the other task', () => {
    render(<TaskCard task={task()} onClick={vi.fn()} fileOverlaps={[{ taskId: 't2', title: 'Other', files: ['a.ts', 'b.ts'] }]} />);
    const badge = screen.getByTestId('task-card-overlap-badge');
    expect(badge).toHaveTextContent('overlap.badge');
    expect(badge).toHaveTextContent('Other');
    expect(badge).not.toHaveTextContent('badgeMore');
  });

  it('adds a count for more than one overlapping task', () => {
    render(
      <TaskCard
        task={task()}
        onClick={vi.fn()}
        fileOverlaps={[
          { taskId: 't2', title: 'Other', files: ['a.ts'] },
          { taskId: 't3', title: 'Third', files: ['a.ts'] },
        ]}
      />
    );
    expect(screen.getByTestId('task-card-overlap-badge')).toHaveTextContent('overlap.badgeMore');
  });

  it('shows nothing when there are no overlaps', () => {
    render(<TaskCard task={task()} onClick={vi.fn()} fileOverlaps={[]} />);
    expect(screen.queryByTestId('task-card-overlap-badge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('task-card-waiting-badge')).not.toBeInTheDocument();
  });

  it('shows the waiting badge with the blocker title', () => {
    render(<TaskCard task={task()} onClick={vi.fn()} holdBlockerTitle="Blocker" />);
    expect(screen.getByTestId('task-card-waiting-badge')).toHaveTextContent('Blocker');
  });
});
