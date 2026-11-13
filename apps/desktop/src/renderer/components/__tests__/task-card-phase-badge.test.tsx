/**
 * @vitest-environment jsdom
 *
 * zeenha fork: the execution phase badge on a TaskCard is translated through
 * the real i18n instance instead of showing the English label.
 */
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { TaskCard } from '../TaskCard';
import { TooltipProvider } from '../ui/tooltip';
import { useTaskStore } from '../../stores/task-store';
import i18n from '../../../shared/i18n';

beforeAll(async () => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as Record<string, unknown>).ResizeObserver = class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    };
  }
  if (!('IntersectionObserver' in globalThis)) {
    (globalThis as Record<string, unknown>).IntersectionObserver = class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    };
  }
  await i18n.changeLanguage('fr');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => useTaskStore.setState({ tasks: [] }));

const mk = (over: Record<string, unknown>) =>
  ({
    id: 'x',
    specId: '001-x',
    projectId: 'p1',
    title: 'X',
    description: '',
    status: 'in_progress',
    subtasks: [],
    logs: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as never;

const renderPhase = (phase: string) => {
  const task = mk({
    executionProgress: { phase, phaseProgress: 0, overallProgress: 0 },
  });
  useTaskStore.setState({ tasks: [task] });
  return render(
    <I18nextProvider i18n={i18n}>
      <TooltipProvider>
        <TaskCard task={task} onClick={() => {}} />
      </TooltipProvider>
    </I18nextProvider>
  );
};

/** The phase badge is the element holding the spinner icon next to the label. */
const badgeWithText = (container: HTMLElement, text: string) => {
  const badges = Array.from(container.querySelectorAll('svg.animate-spin'))
    .map((svg) => svg.parentElement)
    .filter((el): el is HTMLElement => !!el && el.textContent === text);
  return badges[0];
};

describe('TaskCard execution phase badge i18n', () => {
  it('shows the French label for the coding phase', () => {
    const { container } = renderPhase('coding');
    expect(badgeWithText(container, 'Codage')).toBeDefined();
    expect(screen.getAllByText('Codage').length).toBeGreaterThan(0);
    expect(screen.queryByText('Coding')).toBeNull();
  });

  it('shows the French label for the qa_review phase', () => {
    const { container } = renderPhase('qa_review');
    expect(badgeWithText(container, 'Révision')).toBeDefined();
    expect(screen.queryByText('Reviewing')).toBeNull();
  });

  it('shows the English label when the language is English', async () => {
    await i18n.changeLanguage('en');
    try {
      const { container } = renderPhase('coding');
      expect(badgeWithText(container, 'Coding')).toBeDefined();
      expect(screen.queryByText('Codage')).toBeNull();
    } finally {
      await i18n.changeLanguage('fr');
    }
  });
});
