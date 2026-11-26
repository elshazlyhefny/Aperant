/**
 * @vitest-environment jsdom
 *
 * zeenha fork: the review badge shows the recorded review reason. Every
 * human_review task is persisted with executionPhase 'complete', so "Completed"
 * appears only when no reason was recorded.
 */
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { TaskCard } from '../TaskCard';
import { TooltipProvider } from '../ui/tooltip';
import { useTaskStore } from '../../stores/task-store';
import i18n from '../../../shared/i18n';

beforeAll(async () => {
  for (const name of ['ResizeObserver', 'IntersectionObserver']) {
    if (!(name in globalThis)) {
      (globalThis as Record<string, unknown>)[name] = class {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      };
    }
  }
  await i18n.changeLanguage('en');
});

afterEach(() => useTaskStore.setState({ tasks: [] }));

const renderReview = (reviewReason?: string) => {
  const task = {
    id: 'x',
    specId: '001-x',
    projectId: 'p1',
    title: 'X',
    description: '',
    status: 'human_review',
    reviewReason,
    // A finished build: with no reason and no completed subtask the card shows "Incomplete".
    subtasks: [{ id: 's1', title: 'S1', description: '', status: 'completed', files: [] }],
    logs: [],
    executionProgress: { phase: 'complete', phaseProgress: 100, overallProgress: 100 },
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never;
  useTaskStore.setState({ tasks: [task] });
  return render(
    <I18nextProvider i18n={i18n}>
      <TooltipProvider>
        <TaskCard task={task} onClick={vi.fn()} />
      </TooltipProvider>
    </I18nextProvider>
  );
};

describe('TaskCard review reason badge', () => {
  it('shows Stopped for a stopped task even though its phase is complete', () => {
    renderReview('stopped');
    expect(screen.getByText('Stopped')).toBeInTheDocument();
    expect(screen.queryByText('Completed')).toBeNull();
  });

  it('keeps the account reason for a task waiting on an account', () => {
    renderReview('account_required');
    expect(screen.getByText('Account needed')).toBeInTheDocument();
    expect(screen.queryByText('Completed')).toBeNull();
  });

  it('shows Completed when no reason was recorded and the phase is complete', () => {
    renderReview(undefined);
    expect(screen.getByText('Completed')).toBeInTheDocument();
  });
});
