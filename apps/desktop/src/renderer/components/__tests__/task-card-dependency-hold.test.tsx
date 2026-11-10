/**
 * @vitest-environment jsdom
 *
 * zeenha fork: a queued task with task dependencies shows a held badge:
 * "waiting" while the dependency is unfinished (including an open PR) and a
 * warning "blocked" badge when the dependency failed or is missing.
 */
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts?.title ? `${key}|${opts.title}` : key),
    i18n: { language: 'en' },
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { TaskCard } from '../TaskCard';
import { TooltipProvider } from '../ui/tooltip';
import { useTaskStore } from '../../stores/task-store';

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as Record<string, unknown>).ResizeObserver = class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    };
  }
});

const mk = (over: Record<string, unknown>) =>
  ({
    id: 'x',
    specId: '001-x',
    projectId: 'p1',
    title: 'X',
    description: '',
    status: 'backlog',
    subtasks: [],
    logs: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as never;

const renderWith = (dep: Record<string, unknown> | null) => {
  const queued = mk({ id: 'q', specId: '002-q', title: 'Queued', status: 'queue', metadata: { taskDependencies: ['dep'] } });
  useTaskStore.setState({ tasks: dep ? [queued, mk({ id: 'dep', specId: '003-dep', title: 'Dep', ...dep })] : [queued] });
  render(
    <TooltipProvider>
      <TaskCard task={queued} onClick={() => {}} />
    </TooltipProvider>
  );
};

afterEach(() => useTaskStore.setState({ tasks: [] }));

describe('TaskCard dependency hold badge', () => {
  it('shows a waiting badge for an unfinished dependency', () => {
    renderWith({ status: 'in_progress' });
    const badge = screen.getByTestId('task-card-dependency-hold');
    expect(badge).toHaveAttribute('data-state', 'waiting');
    expect(badge).toHaveTextContent('tasks:dependencies.waitingFor|Dep');
  });

  it('keeps waiting for a dependency whose PR is not merged', () => {
    renderWith({ status: 'pr_created' });
    expect(screen.getByTestId('task-card-dependency-hold')).toHaveAttribute('data-state', 'waiting');
  });

  it('shows a warning blocked badge for a failed dependency', () => {
    renderWith({ status: 'error' });
    const badge = screen.getByTestId('task-card-dependency-hold');
    expect(badge).toHaveAttribute('data-state', 'blocked');
    expect(badge).toHaveTextContent('tasks:dependencies.heldFailed|Dep');
    expect(badge.className).toContain('text-warning');
  });

  it('shows a blocked badge for a missing dependency', () => {
    renderWith(null);
    expect(screen.getByTestId('task-card-dependency-hold')).toHaveAttribute('data-state', 'blocked');
  });

  it('shows no badge once the dependency is done', () => {
    renderWith({ status: 'done' });
    expect(screen.queryByTestId('task-card-dependency-hold')).toBeNull();
  });
});
