/**
 * @vitest-environment jsdom
 *
 * zeenha fork: expanded phase entries are virtualized so huge logs stay cheap.
 */
import '@testing-library/jest-dom/vitest';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

import { TaskLogs } from '../TaskLogs';

function makeLogs(count: number) {
  const entries = Array.from({ length: count }, (_, i) => ({
    timestamp: new Date(2026, 0, 1, 0, 0, i).toISOString(),
    type: 'text',
    content: `entry-${i}`,
    phase: 'coding',
  }));
  const empty = { phase: 'x', status: 'pending', started_at: null, completed_at: null, entries: [] };
  return {
    spec_id: 's',
    created_at: '',
    updated_at: '',
    phases: {
      planning: { ...empty, phase: 'planning' },
      coding: { ...empty, phase: 'coding', status: 'active', entries },
      validation: { ...empty, phase: 'validation' },
    },
  } as never;
}

function renderLogs(count: number) {
  const ref = { current: null } as React.RefObject<HTMLDivElement | null>;
  const endRef = { current: null } as React.RefObject<HTMLDivElement | null>;
  return render(
    <TaskLogs
      task={{ id: 't', status: 'in_progress' } as never}
      phaseLogs={makeLogs(count)}
      isLoadingLogs={false}
      expandedPhases={new Set(['coding'])}
      isStuck={false}
      logsEndRef={endRef}
      logsContainerRef={ref}
      onLogsScroll={() => {}}
      onTogglePhase={() => {}}
    />
  );
}

beforeEach(() => {
  // jsdom has no layout: give every element a 400px-tall viewport / 28px rows
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 400 });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 });
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 800, height: 400, top: 0, left: 0, right: 800, bottom: 400, x: 0, y: 0, toJSON() {} }) as DOMRect;
});

describe('TaskLogs virtualization', () => {
  it('renders only a bounded number of rows for a large phase', () => {
    const { container } = renderLogs(500);
    const rows = container.querySelectorAll('[data-index]');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(100);
  });

  it('renders every entry of a small phase', () => {
    const { container, getByText } = renderLogs(10);
    expect(container.querySelectorAll('[data-index]').length).toBe(0);
    for (let i = 0; i < 10; i++) expect(getByText(`entry-${i}`)).toBeInTheDocument();
  });
});
