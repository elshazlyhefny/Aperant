import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Project, Task, TaskStatus } from '../../shared/types';

vi.mock('../ipc-handlers/utils', () => ({ safeSendToRenderer: vi.fn() }));
vi.mock('../ipc-handlers/task/plan-file-utils', () => ({
  getPlanPath: vi.fn(() => '/mock/path/implementation_plan.json'),
  persistPlanStatusAndReasonSync: vi.fn()
}));
vi.mock('../worktree-paths', () => ({ findTaskWorktree: vi.fn(() => null) }));
vi.mock('fs', () => ({ existsSync: vi.fn(() => false) }));
vi.mock('../app-logger', () => ({
  appLog: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() }
}));

import { TaskStateManager } from '../task-state-manager';
import { TaskQueueManager } from '../task-queue-manager';

const PROJECT_ID = 'p1';
const project = { id: PROJECT_ID, name: 'p1', path: '/tmp/p1', settings: { maxParallelTasks: 1 } } as unknown as Project;

function makeTask(id: string, status: TaskStatus, createdAt: number): Task {
  return {
    id, specId: id, projectId: PROJECT_ID, title: id, description: '', status,
    subtasks: [], logs: [], createdAt: new Date(createdAt), updatedAt: new Date()
  } as unknown as Task;
}

function qaPassed(task: Task) {
  return {
    type: 'QA_PASSED', taskId: task.id, specId: task.specId, projectId: PROJECT_ID,
    timestamp: new Date().toISOString(), eventId: `evt-${task.id}`, sequence: 0,
    iteration: 1, testsRun: {}
  };
}

describe('task state manager -> task queue wiring (no window)', () => {
  let stateManager: TaskStateManager;
  let queueManager: TaskQueueManager;
  let tasks: Task[];
  let promoteCalls: string[];
  let maxInProgress: number;

  const inProgress = () => tasks.filter((t) => t.status === 'in_progress').length;

  beforeEach(() => {
    vi.clearAllMocks();
    promoteCalls = [];
    maxInProgress = 0;
    tasks = [
      makeTask('running-1', 'in_progress', 1000),
      makeTask('running-2', 'in_progress', 1001),
      makeTask('queued-old', 'queue', 2000),
      makeTask('queued-new', 'queue', 3000)
    ];
    stateManager = new TaskStateManager();
    stateManager.configure(() => null);
    queueManager = new TaskQueueManager({
      getProjects: () => [project],
      getTasks: () => tasks,
      promote: async (taskId) => {
        promoteCalls.push(taskId);
        const t = tasks.find((x) => x.id === taskId);
        if (t) t.status = 'in_progress';
        maxInProgress = Math.max(maxInProgress, inProgress());
        return { success: true };
      }
    });
    // Mirror the persisted status first so the queue sees the new state
    stateManager.onStatusEmitted((taskId, status) => {
      const t = tasks.find((x) => x.id === taskId);
      if (t) t.status = status;
    });
    stateManager.onStatusEmitted((taskId, status, projectId) => {
      void queueManager.onTaskStatusChanged(taskId, status, projectId);
    });
  });

  afterEach(() => {
    stateManager.clearAllTasks();
  });

  const flush = () => queueManager.requestProcess(PROJECT_ID);

  it('promotes the oldest queued task exactly once when the running task exits', async () => {
    tasks = tasks.filter((t) => t.id !== 'running-2');
    const running = tasks[0];
    stateManager.handleTaskEvent(running.id, qaPassed(running), running, project);
    await flush();

    expect(promoteCalls).toEqual(['queued-old']);
    expect(tasks.find((t) => t.id === 'queued-new')?.status).toBe('queue');
    expect(maxInProgress).toBeLessThanOrEqual(1);
  });

  it('never double-promotes or exceeds the limit with near-simultaneous exits', async () => {
    const [r1, r2] = tasks;
    stateManager.handleTaskEvent(r1.id, qaPassed(r1), r1, project);
    stateManager.handleTaskEvent(r2.id, qaPassed(r2), r2, project);
    await flush();
    await flush();

    expect(promoteCalls).toEqual(['queued-old']);
    expect(new Set(promoteCalls).size).toBe(promoteCalls.length);
    expect(inProgress()).toBe(1);
    expect(maxInProgress).toBeLessThanOrEqual(1);
    expect(tasks.find((t) => t.id === 'queued-new')?.status).toBe('queue');
  });
});

describe('queue promotion through the real state machine', () => {
  it('stops at the parallel limit when a queued task is promoted', async () => {
    const stateManager = new TaskStateManager();
    stateManager.configure(() => null);
    const tasks = [1, 2, 3, 4, 5].map((n) => makeTask(`queued-${n}`, 'queue', 1000 + n));
    const promoteCalls: string[] = [];
    const queueManager = new TaskQueueManager({
      getProjects: () => [project],
      getTasks: () => tasks,
      // Same call applyTaskStatusUpdate makes for a promotion
      promote: async (taskId) => {
        promoteCalls.push(taskId);
        const t = tasks.find((x) => x.id === taskId) as Task;
        stateManager.handleManualStatusChange(taskId, 'in_progress', t, project);
        return { success: true };
      }
    });
    stateManager.onStatusEmitted((taskId, status) => {
      const t = tasks.find((x) => x.id === taskId);
      if (t) t.status = status;
    });
    stateManager.onStatusEmitted((taskId, status, projectId) => {
      void queueManager.onTaskStatusChanged(taskId, status, projectId);
    });

    await queueManager.requestProcess(PROJECT_ID);
    await queueManager.requestProcess(PROJECT_ID);
    stateManager.clearAllTasks();

    expect(promoteCalls).toEqual(['queued-1']);
    expect(tasks.map((t) => t.status)).toEqual(['in_progress', 'queue', 'queue', 'queue', 'queue']);
  });
});
