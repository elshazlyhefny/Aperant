/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { holder?: string }) => `${key}:${opts?.holder ?? ''}`,
    i18n: { language: 'en' },
  }),
}));

import { DaemonQueueBanner } from '../DaemonQueueBanner';

const makeTask = (id: string, status: string) => ({ id, title: `title-${id}`, status }) as never;

describe('DaemonQueueBanner', () => {
  const tasks = [makeTask('001-a', 'in_progress'), makeTask('002-b', 'human_review')];

  it('renders the holder and the paused key', () => {
    render(<DaemonQueueBanner lockedBy="daemon (pid 4123)" taskIds={[]} tasks={tasks} onTaskClick={vi.fn()} />);
    expect(screen.getByText('kanban.daemonQueue.title:daemon (pid 4123)')).toBeInTheDocument();
    expect(screen.getByText(/kanban\.daemonQueue\.paused/)).toBeInTheDocument();
  });

  it('lists only ids that are in_progress', () => {
    render(
      <DaemonQueueBanner lockedBy="d" taskIds={['001-a', '002-b', '999-x']} tasks={tasks} onTaskClick={vi.fn()} />
    );
    expect(screen.getByTestId('daemon-task-001-a')).toBeInTheDocument();
    expect(screen.queryByTestId('daemon-task-002-b')).toBeNull();
    expect(screen.queryByTestId('daemon-task-999-x')).toBeNull();
  });

  it('calls onTaskClick with the task', () => {
    const onTaskClick = vi.fn();
    render(<DaemonQueueBanner lockedBy="d" taskIds={['001-a']} tasks={tasks} onTaskClick={onTaskClick} />);
    fireEvent.click(screen.getByTestId('daemon-task-001-a'));
    expect(onTaskClick).toHaveBeenCalledWith(tasks[0]);
  });
});
