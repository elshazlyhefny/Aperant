/**
 * @vitest-environment jsdom
 *
 * zeenha fork: dragging a task out of the Failed column. Backlog, Queue,
 * In Progress and Done are real moves; AI Review and Human Review are refused
 * (the task did no work), and nothing is dropped into the Failed column.
 */
import '@testing-library/jest-dom/vitest';
import { act, render } from '@testing-library/react';
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
import { useTaskStore } from '../../stores/task-store';
import { ViewStateProvider } from '../../contexts/ViewStateContext';
import { TooltipProvider } from '../ui/tooltip';
import { canDropTask } from '../kanban-columns';
import { canMoveFailedTaskTo } from '../../../shared/utils/task-failure';

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as Record<string, unknown>).ResizeObserver = class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    };
  }
});

const task = (id: string, status: string) =>
  ({
    id,
    specId: `0-${id}`,
    projectId: 'p1',
    title: id,
    description: '',
    status,
    subtasks: [],
    logs: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as never;

const tasks = [task('failed', 'error'), task('review', 'human_review'), task('todo', 'backlog')];

function renderBoard() {
  render(
    <TooltipProvider>
      <ViewStateProvider>
        <KanbanBoard tasks={tasks} onTaskClick={vi.fn()} />
      </ViewStateProvider>
    </TooltipProvider>
  );
  expect(dnd.onDragEnd).toBeTypeOf('function');
}

const drop = (active: string, over: string) =>
  act(async () => {
    await dnd.onDragEnd?.({ active: { id: active }, over: { id: over } });
  });

beforeEach(() => {
  persistTaskStatus.mockReset().mockResolvedValue({ success: true });
  dnd.onDragEnd = undefined;
});

describe('dragging a Failed task', () => {
  it.each(['backlog', 'queue', 'in_progress', 'done'])('moves it to %s', async (column) => {
    renderBoard();
    await drop('failed', column);
    expect(persistTaskStatus).toHaveBeenCalledWith('failed', column);
  });

  it.each(['ai_review', 'human_review'])('refuses %s', async (column) => {
    renderBoard();
    await drop('failed', column);
    expect(persistTaskStatus).not.toHaveBeenCalled();
  });

  it('refuses a drop on a Human Review card too, without reordering that column', async () => {
    renderBoard();
    act(() => {
      useTaskStore.setState({
        taskOrder: { backlog: ['todo'], queue: [], in_progress: [], ai_review: [], human_review: ['review'], done: [], error: ['failed'] } as never,
      });
    });
    await drop('failed', 'review');
    expect(persistTaskStatus).not.toHaveBeenCalled();
    expect(useTaskStore.getState().taskOrder?.human_review).toEqual(['review']);
  });

  it('moves it to Backlog when dropped on a Backlog card', async () => {
    renderBoard();
    await drop('failed', 'todo');
    expect(persistTaskStatus).toHaveBeenCalledWith('failed', 'backlog');
  });

  it('accepts nothing into the Failed column', async () => {
    renderBoard();
    await drop('todo', 'failed');
    expect(persistTaskStatus).not.toHaveBeenCalled();
  });

  it('other tasks still move to Human Review', async () => {
    renderBoard();
    await drop('todo', 'human_review');
    expect(persistTaskStatus).toHaveBeenCalledWith('todo', 'human_review');
  });
});

describe('canDropTask', () => {
  it('follows canMoveFailedTaskTo for a Failed task and refuses the Failed column', () => {
    expect(canMoveFailedTaskTo('backlog')).toBe(true);
    expect(canMoveFailedTaskTo('human_review')).toBe(false);
    expect(canDropTask('error', 'backlog')).toBe(true);
    expect(canDropTask('error', 'done')).toBe(true);
    expect(canDropTask('error', 'ai_review')).toBe(false);
    expect(canDropTask('error', 'human_review')).toBe(false);
    expect(canDropTask('backlog', 'error')).toBe(false);
    expect(canDropTask('backlog', 'human_review')).toBe(true);
  });
});
