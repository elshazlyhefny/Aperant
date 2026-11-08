/**
 * @vitest-environment jsdom
 *
 * zeenha fork: the Kanban board search box. Covers the pure matching helpers,
 * the filtering UI, selection safety and the drag lock while a query is active.
 */
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

type DragHandler = (event: unknown) => unknown;
const dnd: { onDragEnd?: DragHandler; onDragOver?: DragHandler } = {};
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: (props: { children: ReactNode; onDragEnd: DragHandler; onDragOver: DragHandler }) => {
      dnd.onDragEnd = props.onDragEnd;
      dnd.onDragOver = props.onDragOver;
      return props.children;
    },
  };
});

const persistTaskStatus = vi.fn();
vi.mock('../../stores/task-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/task-store')>();
  return {
    ...actual,
    persistTaskStatus: (...a: unknown[]) => persistTaskStatus(...a),
    isQueueAtCapacity: () => false,
  };
});
vi.mock('../../hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { KanbanBoard } from '../KanbanBoard';
import { ViewStateProvider } from '../../contexts/ViewStateContext';
import { TooltipProvider } from '../ui/tooltip';
import { filterColumnsBySearch, taskMatchesSearch } from '../kanban-columns';

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as Record<string, unknown>).ResizeObserver = class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    };
  }
});

const makeTask = (id: string, status: string, title: string, specId: string, description = '') =>
  ({
    id,
    specId,
    projectId: 'p1',
    title,
    description,
    status,
    subtasks: [],
    logs: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as never;

const tasks = [
  makeTask('t1', 'backlog', 'Alpha login page', '001-alpha', 'Build the sign in form'),
  makeTask('t2', 'backlog', 'Bravo exporter', '002-bravo', 'CSV export'),
  makeTask('t3', 'human_review', 'Charlie dashboard', '003-charlie'),
  makeTask('t4', 'human_review', 'Delta settings', '004-delta'),
];

function renderBoard() {
  render(
    <TooltipProvider>
      <ViewStateProvider>
        <KanbanBoard tasks={tasks} onTaskClick={vi.fn()} />
      </ViewStateProvider>
    </TooltipProvider>
  );
}

const searchInput = () => screen.getByLabelText('tasks:kanban.searchAriaLabel');
const search = (value: string) => fireEvent.change(searchInput(), { target: { value } });
const drop = (active: string, over: string) =>
  act(async () => {
    await dnd.onDragEnd?.({ active: { id: active }, over: { id: over } });
  });

beforeEach(() => {
  persistTaskStatus.mockReset().mockResolvedValue({ success: true });
  dnd.onDragEnd = undefined;
});

describe('taskMatchesSearch', () => {
  const t = { title: 'Fix Login Bug', description: 'Users cannot Sign in', specId: '042-fix-login' };

  it('matches the title, description and spec ID', () => {
    expect(taskMatchesSearch(t, 'login bug')).toBe(true);
    expect(taskMatchesSearch(t, 'sign in')).toBe(true);
    expect(taskMatchesSearch(t, '042')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(taskMatchesSearch(t, 'FIX LOGIN')).toBe(true);
    expect(taskMatchesSearch(t, 'SIGN IN')).toBe(true);
  });

  it('matches everything for an empty or whitespace query', () => {
    expect(taskMatchesSearch(t, '')).toBe(true);
    expect(taskMatchesSearch(t, '   ')).toBe(true);
  });

  it('does not throw when the description is undefined', () => {
    const noDescription = { title: 'Only title', specId: '001-x' } as never;
    expect(() => taskMatchesSearch(noDescription, 'title')).not.toThrow();
    expect(taskMatchesSearch(noDescription, 'missing')).toBe(false);
  });

  it('does not produce false positives', () => {
    expect(taskMatchesSearch(t, 'zzz-nothing')).toBe(false);
  });
});

describe('filterColumnsBySearch', () => {
  const columns = {
    backlog: [makeTask('a', 'backlog', 'Apple', '001-a'), makeTask('b', 'backlog', 'Banana', '002-b'), makeTask('c', 'backlog', 'Apricot', '003-c')],
    done: [] as never[],
  };

  it('returns the same reference for an empty query', () => {
    expect(filterColumnsBySearch(columns, '')).toBe(columns);
    expect(filterColumnsBySearch(columns, '   ')).toBe(columns);
  });

  it('keeps matching tasks in their original order', () => {
    const result = filterColumnsBySearch(columns, 'ap');
    expect(result.backlog.map((x: { id: string }) => x.id)).toEqual(['a', 'c']);
    expect(result.done).toEqual([]);
  });
});

describe('KanbanBoard search box', () => {
  it('hides non-matching tasks and shows the match count', () => {
    renderBoard();
    expect(screen.getByText('Alpha login page')).toBeInTheDocument();
    expect(screen.getByText('Bravo exporter')).toBeInTheDocument();
    expect(screen.queryByText('tasks:kanban.searchMatchCount')).not.toBeInTheDocument();

    search('alpha');

    expect(screen.getByText('Alpha login page')).toBeInTheDocument();
    expect(screen.queryByText('Bravo exporter')).not.toBeInTheDocument();
    expect(screen.queryByText('Charlie dashboard')).not.toBeInTheDocument();
    expect(screen.getByText('tasks:kanban.searchMatchCount')).toBeInTheDocument();
  });

  it('matches on spec ID', () => {
    renderBoard();
    search('003-charlie');
    expect(screen.getByText('Charlie dashboard')).toBeInTheDocument();
    expect(screen.queryByText('Alpha login page')).not.toBeInTheDocument();
  });

  it('shows the no-matches message in a column with zero matches', () => {
    renderBoard();
    search('alpha');
    expect(screen.getAllByText('kanban.noSearchMatches').length).toBeGreaterThan(0);
  });

  it('restores all tasks with the clear button', () => {
    renderBoard();
    search('alpha');
    fireEvent.click(screen.getByLabelText('tasks:kanban.clearSearch'));

    expect(screen.getByText('Bravo exporter')).toBeInTheDocument();
    expect(screen.getByText('Charlie dashboard')).toBeInTheDocument();
    expect(screen.queryByText('tasks:kanban.searchMatchCount')).not.toBeInTheDocument();
    expect(screen.queryByText('kanban.noSearchMatches')).not.toBeInTheDocument();
  });

  it('restores all tasks when Escape is pressed', () => {
    renderBoard();
    search('alpha');
    fireEvent.keyDown(searchInput(), { key: 'Escape' });

    expect(searchInput()).toHaveValue('');
    expect(screen.getByText('Bravo exporter')).toBeInTheDocument();
    expect(screen.queryByText('tasks:kanban.searchMatchCount')).not.toBeInTheDocument();
  });

  it('keeps the selection when a selected task is hidden by the search', () => {
    renderBoard();
    const checkboxes = screen.getAllByRole('checkbox', { name: 'tasks:actions.selectTask' });
    fireEvent.click(checkboxes[0]);
    expect(screen.getByText('kanban.selectedCountOther')).toBeInTheDocument();

    search('alpha');

    expect(screen.queryByText('Charlie dashboard')).not.toBeInTheDocument();
    expect(screen.queryByText('Delta settings')).not.toBeInTheDocument();
    expect(screen.getByText('kanban.selectedCountOther')).toBeInTheDocument();
  });

  it('ignores drops while a query is active and allows them after clearing', async () => {
    renderBoard();
    search('alpha');
    await drop('t1', 'queue');
    expect(persistTaskStatus).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('tasks:kanban.clearSearch'));
    await drop('t1', 'queue');
    expect(persistTaskStatus).toHaveBeenCalledWith('t1', 'queue');
  });
});
