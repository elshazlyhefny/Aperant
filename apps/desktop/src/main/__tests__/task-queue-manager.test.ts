import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Project, Task } from '../../shared/types';

vi.mock('../app-logger', () => ({
  appLog: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}));

import { TaskQueueManager } from '../task-queue-manager';

let seq = 0;
function makeTask(id: string, status: string, opts: { createdAt?: number; archived?: boolean } = {}): Task {
  return {
    id,
    specId: id,
    projectId: 'p1',
    title: id,
    description: '',
    status,
    subtasks: [],
    logs: [],
    createdAt: new Date(opts.createdAt ?? 1000 + seq++),
    updatedAt: new Date(),
    metadata: opts.archived ? { archivedAt: '2026-01-01' } : undefined,
  } as unknown as Task;
}

function makeProject(id: string, max?: number): Project {
  return { id, name: id, path: `/tmp/${id}`, settings: max === undefined ? {} : { maxParallelTasks: max } } as unknown as Project;
}

function setup(projects: Project[], tasksByProject: Record<string, Task[]>, failIds: string[] = []) {
  const promote = vi.fn(async (taskId: string, projectId: string) => {
    if (failIds.includes(taskId)) return { success: false, error: 'boom' };
    const t = tasksByProject[projectId].find((x) => x.id === taskId);
    if (t) t.status = 'in_progress' as Task['status'];
    return { success: true };
  });
  const emitState = vi.fn();
  const mgr = new TaskQueueManager({
    getProjects: () => projects,
    getTasks: (id) => tasksByProject[id] ?? [],
    promote,
    emitState,
  });
  return { mgr, promote, emitState };
}

const promotedOrder = (promote: ReturnType<typeof vi.fn>) => promote.mock.calls.map((c) => c[0]);

describe('TaskQueueManager', () => {
  beforeEach(() => { seq = 0; });

  it('promotes oldest first', async () => {
    const tasks = [makeTask('new', 'queue', { createdAt: 3000 }), makeTask('old', 'queue', { createdAt: 1000 }), makeTask('mid', 'queue', { createdAt: 2000 })];
    const { mgr, promote } = setup([makeProject('p1', 2)], { p1: tasks });
    await mgr.requestProcess('p1');
    expect(promotedOrder(promote)).toEqual(['old', 'mid']);
  });

  it('promotes exactly (max - running) tasks', async () => {
    const tasks = [makeTask('r1', 'in_progress'), makeTask('q1', 'queue'), makeTask('q2', 'queue'), makeTask('q3', 'queue')];
    const { mgr, promote } = setup([makeProject('p1', 2)], { p1: tasks });
    await mgr.requestProcess('p1');
    expect(promote).toHaveBeenCalledTimes(1);
    expect(mgr.getState('p1')).toMatchObject({ maxParallelTasks: 2, inProgressCount: 2, queuedTaskIds: ['q2', 'q3'] });
  });

  it('uses the default limit when no setting exists', async () => {
    const tasks = Array.from({ length: 6 }, (_, i) => makeTask(`q${i}`, 'queue'));
    const { mgr, promote } = setup([makeProject('p1')], { p1: tasks });
    await mgr.requestProcess();
    expect(promote).toHaveBeenCalledTimes(3);
  });

  it('keeps per-project limits independent', async () => {
    const a = [makeTask('a1', 'queue'), makeTask('a2', 'queue'), makeTask('a3', 'queue')];
    const b = [makeTask('b1', 'queue'), makeTask('b2', 'queue'), makeTask('b3', 'queue')];
    const { mgr, promote } = setup([makeProject('p1', 1), makeProject('p2', 2)], { p1: a, p2: b });
    await mgr.requestProcess();
    expect(promote.mock.calls.filter((c) => c[1] === 'p1')).toHaveLength(1);
    expect(promote.mock.calls.filter((c) => c[1] === 'p2')).toHaveLength(2);
  });

  it('ignores archived tasks', async () => {
    const tasks = [makeTask('run', 'in_progress', { archived: true }), makeTask('arch', 'queue', { archived: true }), makeTask('q1', 'queue')];
    const { mgr, promote } = setup([makeProject('p1', 1)], { p1: tasks });
    await mgr.requestProcess('p1');
    expect(promotedOrder(promote)).toEqual(['q1']);
  });

  it('skips a failed promotion and promotes the next task', async () => {
    const tasks = [makeTask('bad', 'queue', { createdAt: 1 }), makeTask('good', 'queue', { createdAt: 2 })];
    const { mgr, promote } = setup([makeProject('p1', 1)], { p1: tasks }, ['bad']);
    await mgr.requestProcess('p1');
    expect(promotedOrder(promote)).toEqual(['bad', 'good']);
    expect(mgr.getState('p1').skippedTaskIds).toEqual(['bad']);
  });

  it('stops after 10 consecutive failures', async () => {
    const tasks = Array.from({ length: 15 }, (_, i) => makeTask(`q${i}`, 'queue', { createdAt: i }));
    const { mgr, promote } = setup([makeProject('p1', 3)], { p1: tasks }, tasks.map((t) => t.id));
    await mgr.requestProcess('p1');
    expect(promote).toHaveBeenCalledTimes(10);
  });

  it('promotes when a task moves to human_review with no renderer view', async () => {
    const tasks = [makeTask('r1', 'in_progress'), makeTask('q1', 'queue')];
    const { mgr, promote, emitState } = setup([makeProject('p1', 1)], { p1: tasks });
    await mgr.requestProcess('p1');
    expect(promote).not.toHaveBeenCalled();
    tasks[0].status = 'human_review' as Task['status'];
    await mgr.onTaskStatusChanged('r1', 'human_review', 'p1');
    expect(promotedOrder(promote)).toEqual(['q1']);
    expect(emitState).toHaveBeenLastCalledWith('p1', expect.objectContaining({ inProgressCount: 1 }));
  });

  it('does not process on an in_progress status change', async () => {
    const { mgr, promote } = setup([makeProject('p1', 2)], { p1: [makeTask('q1', 'queue')] });
    await mgr.onTaskStatusChanged('x', 'in_progress', 'p1');
    expect(promote).not.toHaveBeenCalled();
  });

  it('starts each task once for simultaneous requests and respects the limit', async () => {
    const tasks = [makeTask('q1', 'queue'), makeTask('q2', 'queue'), makeTask('q3', 'queue')];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const projects = [makeProject('p1', 2)];
    const promote = vi.fn(async (taskId: string) => {
      await gate;
      const t = tasks.find((x) => x.id === taskId);
      if (t) t.status = 'in_progress' as Task['status'];
      return { success: true };
    });
    const mgr = new TaskQueueManager({ getProjects: () => projects, getTasks: () => tasks, promote });
    const both = Promise.all([mgr.onTaskStatusChanged('a', 'human_review', 'p1'), mgr.requestProcess('p1')]);
    await Promise.resolve();
    release();
    await both;
    expect(promotedOrder(promote)).toEqual(['q1', 'q2']);
    expect(tasks.filter((t) => t.status === 'in_progress')).toHaveLength(2);
  });

  it('counts a promoted task whose file status is still queue toward capacity', async () => {
    const tasks = [makeTask('q1', 'queue'), makeTask('q2', 'queue')];
    const promote = vi.fn(async () => ({ success: true })); // never flips status
    const mgr = new TaskQueueManager({ getProjects: () => [makeProject('p1', 1)], getTasks: () => tasks, promote });
    await mgr.requestProcess('p1');
    await mgr.requestProcess('p1');
    expect(promotedOrder(promote)).toEqual(['q1']);
    expect(mgr.getState('p1')).toMatchObject({ inProgressCount: 1, queuedTaskIds: ['q2'] });
    // Once the task moves on, it is pruned and the slot frees up
    tasks[0].status = 'human_review' as Task['status'];
    await mgr.requestProcess('p1');
    expect(promotedOrder(promote)).toEqual(['q1', 'q2']);
  });

  it('does not stall when a promoted task is dragged back to the queue', async () => {
    const tasks = [makeTask('a', 'queue', { createdAt: 1 }), makeTask('b', 'queue', { createdAt: 2 })];
    const promote = vi.fn(async () => ({ success: true })); // never flips status
    const mgr = new TaskQueueManager({ getProjects: () => [makeProject('p1', 1)], getTasks: () => tasks, promote });
    await mgr.requestProcess('p1');
    expect(promotedOrder(promote)).toEqual(['a']);
    // User drags the running task back to the Queue column
    await mgr.onTaskStatusChanged('a', 'queue', 'p1');
    // 'a' is re-considered (oldest) instead of holding a phantom slot
    expect(promotedOrder(promote)).toEqual(['a', 'a']);
    expect(mgr.getState('p1')).toMatchObject({ inProgressCount: 1, queuedTaskIds: ['b'] });
  });

  it('holds a task until its dependencies are done, without marking it failed', async () => {
    const parent = makeTask('parent', 'human_review', { createdAt: 1 });
    const child = makeTask('child', 'queue', { createdAt: 2 });
    child.metadata = { taskDependencies: ['parent'] } as Task['metadata'];
    const later = makeTask('later', 'queue', { createdAt: 3 });
    const { mgr, promote, emitState } = setup([makeProject('p1', 1)], { p1: [parent, child, later] });

    await mgr.requestProcess('p1');
    expect(promotedOrder(promote)).toEqual(['later']);
    expect(emitState.mock.calls.at(-1)?.[1].skippedTaskIds).toEqual([]);

    later.status = 'done' as Task['status'];
    parent.status = 'done' as Task['status'];
    await mgr.onTaskStatusChanged('parent', 'done', 'p1');
    expect(promotedOrder(promote)).toEqual(['later', 'child']);
  });

  it('leaves scheduled tasks to the scheduler', async () => {
    const scheduled = makeTask('scheduled', 'queue', { createdAt: 1 });
    scheduled.metadata = { scheduleId: 's1' } as Task['metadata'];
    const manual = makeTask('manual', 'queue', { createdAt: 2 });
    const { mgr, promote } = setup([makeProject('p1', 2)], { p1: [scheduled, manual] });
    await mgr.requestProcess('p1');
    expect(promotedOrder(promote)).toEqual(['manual']);
  });

  it('keeps going when one project throws', async () => {
    const good = [makeTask('g1', 'queue')];
    const promote = vi.fn(async () => ({ success: true }));
    const mgr = new TaskQueueManager({
      getProjects: () => [makeProject('bad', 1), makeProject('p1', 1)],
      getTasks: (id) => { if (id === 'bad') throw new Error('x'); return good; },
      promote,
    });
    await mgr.requestProcess();
    expect(promotedOrder(promote)).toEqual(['g1']);
  });
});
