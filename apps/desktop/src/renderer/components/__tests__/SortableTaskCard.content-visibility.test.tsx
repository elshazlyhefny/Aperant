/**
 * @vitest-environment jsdom
 *
 * zeenha fork: off-screen Kanban cards skip layout/paint via content-visibility.
 * The class lives on an inner wrapper (not the dnd-kit node) and is dropped
 * while a drag is active.
 */
import '@testing-library/jest-dom/vitest';
import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

const dragState = vi.hoisted(() => ({ active: false }));
vi.mock('@dnd-kit/sortable', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/sortable')>();
  return {
    ...actual,
    useSortable: (args: Parameters<typeof actual.useSortable>[0]) => {
      const result = actual.useSortable(args);
      return dragState.active ? { ...result, active: { id: 't1' } as never } : result;
    },
  };
});

import { SortableTaskCard } from '../SortableTaskCard';
import { TooltipProvider } from '../ui/tooltip';

const stub = class {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
};

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as Record<string, unknown>).ResizeObserver = stub;
  }
  if (!('IntersectionObserver' in globalThis)) {
    (globalThis as Record<string, unknown>).IntersectionObserver = stub;
  }
});

afterEach(() => {
  dragState.active = false;
});

const task = {
  id: 't1',
  specId: '001-t1',
  projectId: 'p1',
  title: 'Task one',
  description: '',
  status: 'backlog',
  subtasks: [],
  logs: [],
  createdAt: new Date(),
  updatedAt: new Date(),
} as never;

const renderCard = (onClick = vi.fn()) => {
  render(
    <TooltipProvider>
      <DndContext>
        <SortableContext items={['t1']}>
          <SortableTaskCard task={task} onClick={onClick} />
        </SortableContext>
      </DndContext>
    </TooltipProvider>
  );
  const outer = screen.getByText('Task one').closest('[aria-roledescription]') as HTMLElement;
  return { outer, onClick };
};

const SKIP = 'kanban-card-offscreen-skip';

describe('SortableTaskCard content-visibility', () => {
  it('puts the skip class on an inner wrapper when idle', () => {
    const { outer } = renderCard();
    const inner = outer.querySelector(`.${SKIP}`);
    expect(inner).not.toBeNull();
    expect(inner).not.toBe(outer);
    expect(outer.contains(inner)).toBe(true);
  });

  it('does not put the skip class on the dnd-kit node', () => {
    const { outer } = renderCard();
    expect(outer).not.toHaveClass(SKIP);
  });

  it('drops the skip class while a drag is active', () => {
    dragState.active = true;
    const { outer } = renderCard();
    expect(outer.querySelector(`.${SKIP}`)).toBeNull();
    expect(outer).not.toHaveClass(SKIP);
  });

  it('still opens on Enter exactly once', () => {
    const { outer, onClick } = renderCard();
    fireEvent.keyDown(outer, { key: 'Enter' });
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('globals.css', () => {
  it('keeps the content-visibility rule', () => {
    const css = readFileSync(resolve(__dirname, '../../styles/globals.css'), 'utf8');
    const match = css.match(/\.kanban-card-offscreen-skip\s*\{([^}]*)\}/);
    expect(match).not.toBeNull();
    expect(match?.[1]).toContain('content-visibility: auto');
    expect(match?.[1]).toContain('contain-intrinsic-size');
  });
});
