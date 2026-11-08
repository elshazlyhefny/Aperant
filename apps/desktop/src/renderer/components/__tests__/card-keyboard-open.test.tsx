/**
 * @vitest-environment jsdom
 *
 * zeenha fork: keyboard users can open task, roadmap, idea and issue cards.
 * Enter on a focused sortable card opens it (Space stays with dnd-kit), and a
 * nested button keeps its own key handling.
 */
import '@testing-library/jest-dom/vitest';
import { DndContext, KeyboardCode } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

const sensorOptions: Array<{ sensor: unknown; options: unknown }> = [];
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    useSensor: (sensor: unknown, options?: unknown) => {
      sensorOptions.push({ sensor, options });
      return actual.useSensor(sensor as never, options as never);
    },
  };
});

import { KeyboardSensor } from '@dnd-kit/core';
import { KanbanBoard } from '../KanbanBoard';
import { RoadmapKanbanView } from '../RoadmapKanbanView';
import { SortableTaskCard } from '../SortableTaskCard';
import { SortableFeatureCard } from '../SortableFeatureCard';
import { IdeaCard } from '../ideation/IdeaCard';
import { FeatureCard } from '../roadmap/FeatureCard';
import { IssueListItem } from '../github-issues/components/IssueListItem';
import { ViewStateProvider } from '../../contexts/ViewStateContext';
import { TooltipProvider } from '../ui/tooltip';

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as Record<string, unknown>).ResizeObserver = class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    };
  }
});

beforeAll(() => {
  if (!('IntersectionObserver' in globalThis)) {
    (globalThis as Record<string, unknown>).IntersectionObserver = class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    };
  }
});

beforeEach(() => {
  sensorOptions.length = 0;
});

const task = (status: string) =>
  ({
    id: 't1',
    specId: '001-t1',
    projectId: 'p1',
    title: 'Task one',
    description: '',
    status,
    subtasks: [],
    logs: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as never;

const feature = {
  id: 'f1',
  title: 'Feature one',
  description: 'desc',
  rationale: '',
  priority: 'must',
  complexity: 'low',
  impact: 'high',
  phaseId: 'p1',
  dependencies: [],
  status: 'planned',
  acceptanceCriteria: [],
  userStories: [],
} as never;

const withDnd = (ui: ReactNode, id: string) =>
  render(
    <TooltipProvider>
      <DndContext>
        <SortableContext items={[id]}>{ui}</SortableContext>
      </DndContext>
    </TooltipProvider>
  );

const wrapperOf = (text: string) => screen.getByText(text).closest('[aria-roledescription]') as HTMLElement;

describe('SortableTaskCard', () => {
  it('opens on Enter on the wrapper, once', () => {
    const onClick = vi.fn();
    withDnd(<SortableTaskCard task={task('backlog')} onClick={onClick} />, 't1');
    const wrapper = wrapperOf('Task one');
    expect(wrapper).toHaveClass('focus-visible:ring-2');
    fireEvent.keyDown(wrapper, { key: 'Enter' });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not open on Enter from a nested button, or on Space', () => {
    const onClick = vi.fn();
    withDnd(<SortableTaskCard task={task('backlog')} onClick={onClick} />, 't1');
    const wrapper = wrapperOf('Task one');
    const nested = wrapper.querySelector('button');
    if (nested) fireEvent.keyDown(nested, { key: 'Enter' });
    fireEvent.keyDown(wrapper, { key: ' ', code: 'Space' });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('opens a running task (sortable disabled) on Enter', () => {
    const onClick = vi.fn();
    withDnd(<SortableTaskCard task={task('in_progress')} onClick={onClick} />, 't1');
    expect(() => fireEvent.keyDown(wrapperOf('Task one'), { key: 'Enter' })).not.toThrow();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('SortableFeatureCard', () => {
  const onConvertToSpec = vi.fn();

  it('opens on Enter on the wrapper, once', () => {
    const onClick = vi.fn();
    withDnd(<SortableFeatureCard feature={feature} onClick={onClick} onConvertToSpec={onConvertToSpec} />, 'f1');
    const wrapper = wrapperOf('Feature one');
    expect(wrapper).toHaveClass('focus-visible:ring-2');
    fireEvent.keyDown(wrapper, { key: 'Enter' });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not open on Enter from a nested button, or on Space', () => {
    const onClick = vi.fn();
    withDnd(<SortableFeatureCard feature={feature} onClick={onClick} onConvertToSpec={onConvertToSpec} />, 'f1');
    const wrapper = wrapperOf('Feature one');
    const nested = wrapper.querySelector('button');
    expect(nested).not.toBeNull();
    fireEvent.keyDown(nested as HTMLElement, { key: 'Enter' });
    fireEvent.keyDown(wrapper, { key: ' ', code: 'Space' });
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('plain cards', () => {
  const idea = {
    id: 'i1',
    type: 'code_improvements',
    title: 'Idea one',
    description: 'd',
    rationale: 'r',
    status: 'draft',
    createdAt: new Date(),
    buildsUpon: [],
    estimatedEffort: 'small',
    affectedFiles: [],
    existingPatterns: [],
  } as never;
  const issue = {
    id: 1,
    number: 7,
    title: 'Issue one',
    state: 'open',
    labels: [],
    assignees: [],
    author: { login: 'a' },
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    commentsCount: 0,
    url: '',
    htmlUrl: '',
    repoFullName: 'o/r',
  } as never;

  const cases: Array<[string, string, (onClick: () => void) => ReactNode]> = [
    [
      'IdeaCard',
      'Idea one',
      (onClick) => (
        <IdeaCard idea={idea} isSelected={false} onClick={onClick} onConvert={vi.fn()} onDismiss={vi.fn()} onToggleSelect={vi.fn()} />
      ),
    ],
    [
      'FeatureCard',
      'Feature one',
      (onClick) => <FeatureCard feature={feature} onClick={onClick} onConvertToSpec={vi.fn()} onGoToTask={vi.fn()} />,
    ],
    [
      'IssueListItem',
      'Issue one',
      (onClick) => <IssueListItem issue={issue} isSelected={false} onClick={onClick} onInvestigate={vi.fn()} />,
    ],
  ];

  it.each(cases)('%s is a focusable button that opens on Enter and Space', (_n, text, build) => {
    const onClick = vi.fn();
    render(<TooltipProvider>{build(onClick)}</TooltipProvider>);
    const card = screen.getByText(text).closest('[role="button"]') as HTMLElement;
    expect(card).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(card, { key: 'Enter' });
    fireEvent.keyDown(card, { key: ' ' });
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it.each(cases)('%s ignores Enter and Space from nested controls', (_n, text, build) => {
    const onClick = vi.fn();
    render(<TooltipProvider>{build(onClick)}</TooltipProvider>);
    const card = screen.getByText(text).closest('[role="button"]') as HTMLElement;
    const nested = Array.from(card.querySelectorAll('button, [role="checkbox"]'));
    for (const el of nested) {
      fireEvent.keyDown(el, { key: 'Enter' });
      fireEvent.keyDown(el, { key: ' ' });
    }
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('keyboard sensor codes', () => {
  const expected = {
    start: [KeyboardCode.Space],
    cancel: [KeyboardCode.Esc],
    end: [KeyboardCode.Space, KeyboardCode.Enter, KeyboardCode.Tab],
  };
  const captured = () =>
    sensorOptions.find((s) => s.sensor === KeyboardSensor)?.options as { keyboardCodes: unknown } | undefined;

  it('KanbanBoard', () => {
    render(
      <TooltipProvider>
        <ViewStateProvider>
          <KanbanBoard tasks={[task('backlog')]} onTaskClick={vi.fn()} />
        </ViewStateProvider>
      </TooltipProvider>
    );
    expect(captured()?.keyboardCodes).toEqual(expected);
  });

  it('RoadmapKanbanView', () => {
    const roadmap = { id: 'r', projectName: 'p', version: '1', vision: '', phases: [], features: [feature], status: 'draft' } as never;
    render(
      <TooltipProvider>
        <RoadmapKanbanView
          roadmap={roadmap}
          onFeatureClick={vi.fn()}
          onConvertToSpec={vi.fn()}
          onGoToTask={vi.fn()}
          onSave={vi.fn()}
        />
      </TooltipProvider>
    );
    expect(captured()?.keyboardCodes).toEqual(expected);
  });
});
