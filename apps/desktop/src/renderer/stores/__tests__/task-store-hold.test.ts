/**
 * @vitest-environment jsdom
 */

/**
 * zeenha fork: tests for the overlap hold in startTaskOrQueue and setTaskHold.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task, TaskStatus } from '../../../shared/types';

const mockStartTask = vi.fn();
const mockUpdateTaskStatus = vi.fn();
const mockUpdateTask = vi.fn();

vi.stubGlobal('window', {
  electronAPI: {
    startTask: mockStartTask,
    updateTaskStatus: mockUpdateTaskStatus,
    updateTask: mockUpdateTask
  }
});

function makeTask(id: string, status: TaskStatus, metadata: Task['metadata'] = {}): Task {
  return {
    id,
    specId: id,
    projectId: 'p1',
    title: id,
    description: '',
    status,
    subtasks: [],
    logs: [],
    metadata,
    createdAt: new Date(),
    updatedAt: new Date()
  } as Task;
}

describe('task-store hold', () => {
  let useTaskStore: typeof import('../task-store').useTaskStore;
  let startTaskOrQueue: typeof import('../task-store').startTaskOrQueue;
  let setTaskHold: typeof import('../task-store').setTaskHold;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mockUpdateTaskStatus.mockResolvedValue({ success: true });
    const mod = await import('../task-store');
    useTaskStore = mod.useTaskStore;
    startTaskOrQueue = mod.startTaskOrQueue;
    setTaskHold = mod.setTaskHold;
  });

  it('queues a held task instead of starting it when capacity is free', async () => {
    useTaskStore.setState({
      tasks: [makeTask('a', 'in_progress'), makeTask('b', 'backlog', { holdUntilTaskId: 'a' })]
    });
    const result = await startTaskOrQueue('b');
    expect(result).toEqual({ action: 'held', success: true });
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith('b', 'queue', undefined);
    expect(mockStartTask).not.toHaveBeenCalled();
  });

  it('starts an unheld task', async () => {
    useTaskStore.setState({ tasks: [makeTask('b', 'backlog')] });
    const result = await startTaskOrQueue('b');
    expect(result).toEqual({ action: 'started', success: true });
    expect(mockStartTask).toHaveBeenCalled();
  });

  it.each(['human_review', 'done', 'pr_created'] as TaskStatus[])(
    'starts normally when the blocker is %s',
    async (status) => {
      useTaskStore.setState({
        tasks: [makeTask('a', status), makeTask('b', 'backlog', { holdUntilTaskId: 'a' })]
      });
      const result = await startTaskOrQueue('b');
      expect(result.action).toBe('started');
    }
  );

  it('starts normally when the blocker is missing', async () => {
    useTaskStore.setState({ tasks: [makeTask('b', 'backlog', { holdUntilTaskId: 'gone' })] });
    const result = await startTaskOrQueue('b');
    expect(result.action).toBe('started');
  });

  it('setTaskHold persists and clears the hold', async () => {
    useTaskStore.setState({ tasks: [makeTask('b', 'backlog')] });
    mockUpdateTask.mockResolvedValue({
      success: true,
      data: { title: 'b', description: '', metadata: { holdUntilTaskId: 'a' } }
    });
    expect(await setTaskHold('b', 'a')).toBe(true);
    expect(mockUpdateTask).toHaveBeenLastCalledWith('b', { metadata: { holdUntilTaskId: 'a' } });
    expect(useTaskStore.getState().tasks[0].metadata?.holdUntilTaskId).toBe('a');

    mockUpdateTask.mockResolvedValue({ success: true, data: { title: 'b', description: '', metadata: {} } });
    expect(await setTaskHold('b', null)).toBe(true);
    expect(mockUpdateTask).toHaveBeenLastCalledWith('b', { metadata: { holdUntilTaskId: undefined } });
    expect(useTaskStore.getState().tasks[0].metadata?.holdUntilTaskId).toBeUndefined();
  });
});
