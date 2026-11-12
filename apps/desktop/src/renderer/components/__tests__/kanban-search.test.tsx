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
import { filterColumnsByFacets, filterColumnsBySearch, taskMatchesSearch } from '../kanban-columns';

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as Record<string, unknown>).ResizeObserver = class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    };
  }
});

const makeTask = (
  id: string,
  status: string,
  title: string,
  specId: string,
  description = '',
  metadata?: Record<string, unknown>
) =>
  ({
    id,
    specId,
    projectId: 'p1',
    title,
    description,
    status,
    metadata,
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

const facetTasks = [
  makeTask('g1', 'backlog', 'Gh issue task', '011-gh', '', { sourceType: 'github', githubIssueNumber: 87, priority: 'high' }),
  makeTask('j1', 'backlog', 'Jira issue task', '012-jira', '', { sourceType: 'jira', jiraIssueKey: 'PROJ-123', priority: 'low' }),
  makeTask('m1', 'human_review', 'Manual plain task', '013-manual'),
  makeTask('g2', 'human_review', 'Gh low task', '014-gh2', '', { sourceType: 'github', priority: 'low' }),
];

function renderBoard(boardTasks: unknown[] = tasks) {
  render(
    <TooltipProvider>
      <ViewStateProvider>
        <KanbanBoard tasks={boardTasks as never[]} onTaskClick={vi.fn()} />
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

describe('taskMatchesSearch issue keys', () => {
  const base = { title: 'Unrelated', description: '', specId: '001-x' };
  const withMeta = (metadata: Record<string, unknown> | undefined) => ({ ...base, metadata }) as never;

  it('matches a Jira key exactly, case-insensitively', () => {
    const t = withMeta({ jiraIssueKey: 'PROJ-123' });
    expect(taskMatchesSearch(t, 'PROJ-123')).toBe(true);
    expect(taskMatchesSearch(t, 'proj-123')).toBe(true);
    expect(taskMatchesSearch(t, ' proj-123 ')).toBe(true);
  });

  it('matches a Linear identifier', () => {
    const t = withMeta({ linearIdentifier: 'ABC-45' });
    expect(taskMatchesSearch(t, 'abc-45')).toBe(true);
  });

  it('matches a single GitHub issue number', () => {
    const t = withMeta({ githubIssueNumber: 87 });
    expect(taskMatchesSearch(t, '#87')).toBe(true);
  });

  it('matches any number of a GitHub batch', () => {
    const t = withMeta({ githubIssueNumbers: [12, 34] });
    expect(taskMatchesSearch(t, '#12')).toBe(true);
    expect(taskMatchesSearch(t, '#34')).toBe(true);
    expect(taskMatchesSearch(t, '#56')).toBe(false);
  });

  it('matches a GitLab iid', () => {
    const t = withMeta({ gitlabIssueIid: 9 });
    expect(taskMatchesSearch(t, '#9')).toBe(true);
  });

  it('does not produce prefix false positives', () => {
    expect(taskMatchesSearch(withMeta({ jiraIssueKey: 'PROJ-1234' }), 'PROJ-123')).toBe(false);
    expect(taskMatchesSearch(withMeta({ githubIssueNumber: 871 }), '#87')).toBe(false);
    expect(taskMatchesSearch(withMeta({ gitlabIssueIid: 91 }), '#9')).toBe(false);
  });

  it('does not throw when metadata is undefined or numbers are 0', () => {
    expect(() => taskMatchesSearch(withMeta(undefined), '#1')).not.toThrow();
    expect(taskMatchesSearch(withMeta(undefined), '#1')).toBe(false);
    expect(taskMatchesSearch(withMeta({ githubIssueNumber: 0 }), '#0')).toBe(false);
  });
});

describe('filterColumnsByFacets', () => {
  const columns = {
    backlog: [
      makeTask('a', 'backlog', 'A', '001-a', '', { sourceType: 'github', priority: 'high' }),
      makeTask('b', 'backlog', 'B', '002-b', '', { sourceType: 'jira', priority: 'low' }),
      makeTask('c', 'backlog', 'C', '003-c', '', { priority: 'high' }),
      makeTask('d', 'backlog', 'D', '004-d'),
      makeTask('e', 'backlog', 'E', '005-e', '', { sourceType: 'github', priority: 'low' }),
    ],
    done: [] as never[],
  };
  const ids = (list: { id: string }[]) => list.map((x) => x.id);
  const none = { sources: [], priorities: [] };

  it('returns the same reference when both facets are empty', () => {
    expect(filterColumnsByFacets(columns, none)).toBe(columns);
  });

  it('filters by source', () => {
    const r = filterColumnsByFacets(columns, { ...none, sources: ['github'] });
    expect(ids(r.backlog)).toEqual(['a', 'e']);
  });

  it('treats a missing sourceType as manual', () => {
    const r = filterColumnsByFacets(columns, { ...none, sources: ['manual'] });
    expect(ids(r.backlog)).toEqual(['c', 'd']);
  });

  it('filters by priority and excludes tasks without one', () => {
    const r = filterColumnsByFacets(columns, { ...none, priorities: ['high'] });
    expect(ids(r.backlog)).toEqual(['a', 'c']);
  });

  it('ANDs the two facets', () => {
    const r = filterColumnsByFacets(columns, { sources: ['github'], priorities: ['low'] });
    expect(ids(r.backlog)).toEqual(['e']);
  });

  it('ORs selections within a facet', () => {
    const r = filterColumnsByFacets(columns, { ...none, sources: ['github', 'jira'] });
    expect(ids(r.backlog)).toEqual(['a', 'b', 'e']);
  });

  it('keeps empty column keys', () => {
    const r = filterColumnsByFacets(columns, { ...none, sources: ['github'] });
    expect(Object.keys(r)).toEqual(['backlog', 'done']);
    expect(r.done).toEqual([]);
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

describe('KanbanBoard search box', { timeout: 20000 }, () => {
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

describe('KanbanBoard source and priority filters', { timeout: 20000 }, () => {
  const openMenu = (name: string) => {
    const trigger = screen.getByLabelText(name);
    fireEvent.keyDown(trigger, { key: 'Enter' });
  };
  const toggle = (menu: string, option: string) => {
    openMenu(menu);
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: option }));
  };
  const source = (s: string) => toggle('tasks:kanban.sourceFilterAriaLabel', `tasks:kanban.sources.${s}`);
  const priority = (p: string) => toggle('tasks:kanban.priorityFilterAriaLabel', `tasks:kanban.priorities.${p}`);

  it('finds a task by Jira key and GitHub number', () => {
    renderBoard(facetTasks);
    search('PROJ-123');
    expect(screen.getByText('Jira issue task')).toBeInTheDocument();
    expect(screen.queryByText('Gh issue task')).not.toBeInTheDocument();
    search('#87');
    expect(screen.getByText('Gh issue task')).toBeInTheDocument();
    expect(screen.queryByText('Jira issue task')).not.toBeInTheDocument();
  });

  it('filters by source and shows the match count', () => {
    renderBoard(facetTasks);
    source('github');
    expect(screen.getByText('Gh issue task')).toBeInTheDocument();
    expect(screen.getByText('Gh low task')).toBeInTheDocument();
    expect(screen.queryByText('Jira issue task')).not.toBeInTheDocument();
    expect(screen.queryByText('Manual plain task')).not.toBeInTheDocument();
    expect(screen.getByText('tasks:kanban.searchMatchCount')).toBeInTheDocument();
  });

  it('treats tasks without a source as manual', () => {
    renderBoard(facetTasks);
    source('manual');
    expect(screen.getByText('Manual plain task')).toBeInTheDocument();
    expect(screen.queryByText('Gh issue task')).not.toBeInTheDocument();
  });

  it('filters by priority', () => {
    renderBoard(facetTasks);
    priority('high');
    expect(screen.getByText('Gh issue task')).toBeInTheDocument();
    expect(screen.queryByText('Gh low task')).not.toBeInTheDocument();
    expect(screen.queryByText('Manual plain task')).not.toBeInTheDocument();
  });

  it('ANDs search with a facet and clears filters', () => {
    renderBoard(facetTasks);
    source('github');
    search('low');
    expect(screen.getByText('Gh low task')).toBeInTheDocument();
    expect(screen.queryByText('Gh issue task')).not.toBeInTheDocument();
    expect(screen.queryByText('Jira issue task')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('tasks:kanban.clearSearch'));
    fireEvent.click(screen.getByText('tasks:kanban.clearFilters'));
    expect(screen.getByText('Gh issue task')).toBeInTheDocument();
    expect(screen.getByText('Jira issue task')).toBeInTheDocument();
    expect(screen.getByText('Manual plain task')).toBeInTheDocument();
    expect(screen.queryByText('tasks:kanban.clearFilters')).not.toBeInTheDocument();
  });

  it('ignores drops while a facet is active and allows them after clearing', async () => {
    renderBoard(facetTasks);
    source('github');
    await drop('g1', 'queue');
    expect(persistTaskStatus).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('tasks:kanban.clearFilters'));
    await drop('g1', 'queue');
    expect(persistTaskStatus).toHaveBeenCalledWith('g1', 'queue');
  });

  it('keeps the selection when a selected task is hidden by a facet', () => {
    renderBoard(facetTasks);
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'tasks:actions.selectTask' })[0]);
    expect(screen.getByText('kanban.selectedCountOther')).toBeInTheDocument();
    source('jira');
    expect(screen.queryByText('Manual plain task')).not.toBeInTheDocument();
    expect(screen.getByText('kanban.selectedCountOther')).toBeInTheDocument();
  });
});
