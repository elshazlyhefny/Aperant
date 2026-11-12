/**
 * @vitest-environment jsdom
 *
 * zeenha fork: the task detail panel says when planned files are unknown, when
 * nothing overlaps, and which tasks share files.
 */
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let mockTasks: unknown[] = [];

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}|${JSON.stringify(opts)}` : key),
    i18n: { language: 'en' },
  }),
}));
vi.mock('../../../stores/task-store', () => ({
  setTaskHold: vi.fn(),
  useTaskStore: (selector: (s: { tasks: unknown[] }) => unknown) => selector({ tasks: mockTasks }),
}));
vi.mock('../../../hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { TaskFileOverlap } from '../TaskFileOverlap';

const task = (id: string, title: string, files: string[] | null, o: Record<string, unknown> = {}) =>
  ({
    id, specId: id, projectId: 'p1', title, description: 'd', status: 'backlog',
    subtasks: files ? [{ id: `${id}-s`, description: 's', status: 'pending', files }] : [],
    logs: [], createdAt: new Date(), updatedAt: new Date(), ...o,
  }) as never;

describe('TaskFileOverlap', () => {
  beforeEach(() => {
    mockTasks = [];
  });

  it('shows unknown when no files are planned', () => {
    const mine = task('t1', 'Mine', null);
    mockTasks = [mine];
    render(<TaskFileOverlap task={mine} />);
    expect(screen.getByTestId('task-overlap-unknown')).toBeInTheDocument();
  });

  it('shows none when no other task shares files', () => {
    const mine = task('t1', 'Mine', ['src/a.ts']);
    mockTasks = [mine, task('t2', 'Other', ['src/b.ts'])];
    render(<TaskFileOverlap task={mine} />);
    expect(screen.getByTestId('task-overlap-none')).toBeInTheDocument();
  });

  it('shows a warning naming the overlapping task and files', () => {
    const mine = task('t1', 'Mine', ['src/a.ts']);
    mockTasks = [mine, task('t2', 'Other', ['src/a.ts'])];
    render(<TaskFileOverlap task={mine} />);
    const warning = screen.getByTestId('task-overlap-warning');
    expect(warning).toHaveTextContent('Other');
    expect(warning).toHaveTextContent('src/a.ts');
  });
});
