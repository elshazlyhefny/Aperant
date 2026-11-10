/**
 * @vitest-environment jsdom
 *
 * zeenha fork: the detail view names overlapping tasks and their shared files,
 * lets the user wait for one, and stays quiet without evidence of overlap.
 */
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}|${JSON.stringify(opts)}` : key),
    i18n: { language: 'en' },
  }),
}));

const toast = vi.fn();
vi.mock('../../../hooks/use-toast', () => ({ useToast: () => ({ toast }) }));

const state: { tasks: unknown[] } = { tasks: [] };
const setTaskHold = vi.fn();
vi.mock('../../../stores/task-store', () => ({
  useTaskStore: (selector: (s: typeof state) => unknown) => selector(state),
  setTaskHold: (...args: unknown[]) => setTaskHold(...args),
}));

import { TaskFileOverlap } from '../TaskFileOverlap';

const sub = (files: string[]) => ({ id: 's', title: 's', description: '', status: 'pending', files });
const task = (id: string, title: string, files: string[] | null, o: Record<string, unknown> = {}) =>
  ({
    id, specId: id, projectId: 'p1', title, description: '', status: 'backlog',
    subtasks: files ? [sub(files)] : [], logs: [], createdAt: new Date(), updatedAt: new Date(), ...o,
  }) as never;

describe('TaskFileOverlap', () => {
  beforeEach(() => {
    setTaskHold.mockReset().mockResolvedValue(true);
    toast.mockReset();
  });

  it('lists shared files and names the other task', () => {
    const mine = task('t1', 'Mine', ['a.ts', 'b.ts']);
    state.tasks = [mine, task('t2', 'Other', ['b.ts', 'c.ts'])];
    render(<TaskFileOverlap task={mine} />);
    expect(screen.getByTestId('task-overlap-warning')).toBeInTheDocument();
    expect(screen.getByText('b.ts')).toBeInTheDocument();
    expect(screen.queryByText('a.ts')).not.toBeInTheDocument();
    expect(screen.getAllByText(/Other/).length).toBeGreaterThan(0);
  });

  it('Wait calls setTaskHold with both ids', () => {
    const mine = task('t1', 'Mine', ['a.ts']);
    state.tasks = [mine, task('t2', 'Other', ['a.ts'])];
    render(<TaskFileOverlap task={mine} />);
    fireEvent.click(screen.getByRole('button'));
    expect(setTaskHold).toHaveBeenCalledWith('t1', 't2');
  });

  it('unknown plan shows the unknown message and no warning', () => {
    const mine = task('t1', 'Mine', null);
    state.tasks = [mine, task('t2', 'Other', ['a.ts'])];
    render(<TaskFileOverlap task={mine} />);
    expect(screen.getByTestId('task-overlap-unknown')).toBeInTheDocument();
    expect(screen.queryByTestId('task-overlap-warning')).not.toBeInTheDocument();
  });

  it('no overlap shows the quiet line', () => {
    const mine = task('t1', 'Mine', ['a.ts']);
    state.tasks = [mine, task('t2', 'Other', ['z.ts'])];
    render(<TaskFileOverlap task={mine} />);
    expect(screen.getByTestId('task-overlap-none')).toBeInTheDocument();
    expect(screen.queryByTestId('task-overlap-warning')).not.toBeInTheDocument();
  });

  it('an active hold shows Stop waiting, which clears the hold', () => {
    const mine = task('t1', 'Mine', ['a.ts'], { metadata: { holdUntilTaskId: 't2' } });
    state.tasks = [mine, task('t2', 'Other', ['a.ts'], { status: 'in_progress' })];
    render(<TaskFileOverlap task={mine} />);
    expect(screen.getByText(/tasks:overlap.waitingFor/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('tasks:overlap.stopWaiting'));
    expect(setTaskHold).toHaveBeenCalledWith('t1', null);
  });

  it('does not render for a finished task', () => {
    const mine = task('t1', 'Mine', ['a.ts'], { status: 'done' });
    state.tasks = [mine];
    const { container } = render(<TaskFileOverlap task={mine} />);
    expect(container).toBeEmptyDOMElement();
  });
});
