import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

import type { AgentExecutorConfig, WorkerMessage } from '../types';
import type { SessionResult } from '../../session/types';

// =============================================================================
// Mocks
// =============================================================================

// Track created workers
const createdWorkers: EventEmitter[] = [];

vi.mock('worker_threads', async () => {
  const { EventEmitter: EE } = require('events') as typeof import('events');
  const actual = await vi.importActual<typeof import('worker_threads')>('worker_threads');

  class MockWorkerImpl extends EE {
    postMessage = vi.fn();
    terminate = vi.fn().mockResolvedValue(0);
    workerData: unknown;
    transferList: unknown;
    constructor(_path: string, opts?: { workerData?: unknown; transferList?: unknown }) {
      super();
      this.workerData = opts?.workerData;
      this.transferList = opts?.transferList;
      createdWorkers.push(this);
    }
  }

  return { Worker: MockWorkerImpl, MessageChannel: actual.MessageChannel };
});

// zeenha fork: memory wiring
const memoryState = {
  enabled: true,
  projects: [{ id: 'proj-456', path: '/project' }] as Array<{ id: string; path: string }>,
};
const handlerInstances: Array<{
  options: { projectId: string; roots: string[]; sessionType: string };
  attach: ReturnType<typeof vi.fn>;
  finalize: ReturnType<typeof vi.fn>;
}> = [];

vi.mock('../../../ipc-handlers/context/memory-service-factory', () => ({
  getMemoryService: vi.fn(),
  isAgentMemoryEnabled: () => memoryState.enabled,
}));

vi.mock('../../../project-store', () => ({
  projectStore: { getProjects: () => memoryState.projects },
}));

vi.mock('../../memory/ipc/main-memory-handler', () => ({
  MainMemoryHandler: class {
    attach = vi.fn();
    finalize = vi.fn().mockResolvedValue({ recorded: 0, inferred: 0 });
    constructor(public options: { projectId: string; roots: string[]; sessionType: string }) {
      handlerInstances.push(this);
    }
  },
}));

function getWorker(): EventEmitter & { postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> } {
  const w = createdWorkers[createdWorkers.length - 1];
  if (!w) throw new Error('No worker created');
  return w as EventEmitter & { postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> };
}

vi.mock('electron', () => ({
  app: { isPackaged: false },
}));

vi.mock('url', () => ({
  fileURLToPath: (url: string) => url.replace('file://', ''),
}));

// Mock ProgressTracker
const mockProcessEvent = vi.fn();
const mockForcePhase = vi.fn();
vi.mock('../../session/progress-tracker', () => ({
  ProgressTracker: class {
    processEvent = mockProcessEvent;
    forcePhase = mockForcePhase;
    state = {
      currentPhase: 'initializing' as const,
      currentSubtask: null,
      currentMessage: 'Starting...',
      completedPhases: [],
    };
  },
}));

// Import after mocks
import { WorkerBridge, WORKER_EXIT_GRACE_MS } from '../worker-bridge';

// =============================================================================
// Helpers
// =============================================================================

function createConfig(overrides: Partial<AgentExecutorConfig> = {}): AgentExecutorConfig {
  return {
    taskId: 'task-123',
    projectId: 'proj-456',
    processType: 'task-execution',
    session: {
      agentType: 'coder',
      systemPrompt: 'test',
      initialMessages: [{ role: 'user', content: 'hello' }],
      maxSteps: 10,
      specDir: '/specs',
      projectDir: '/project',
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-20250514',
      toolContext: { cwd: '/project', projectDir: '/project', specDir: '/specs' },
    },
    ...overrides,
  };
}

function createSessionResult(overrides: Partial<SessionResult> = {}): SessionResult {
  return {
    outcome: 'completed',
    stepsExecuted: 5,
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    messages: [],
    durationMs: 3000,
    toolCallCount: 3,
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('WorkerBridge', () => {
  let bridge: WorkerBridge;

  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    createdWorkers.length = 0;
    handlerInstances.length = 0;
    memoryState.enabled = true;
    memoryState.projects = [{ id: 'proj-456', path: '/project' }];
    bridge = new WorkerBridge();
  });

  // ---------------------------------------------------------------------------
  // Spawning
  // ---------------------------------------------------------------------------

  describe('spawn', () => {
    it('creates a worker and sets isActive to true', () => {
      bridge.spawn(createConfig());
      expect(bridge.isActive).toBe(true);
      expect(createdWorkers.length).toBe(1);
    });

    it('throws if worker already active', () => {
      bridge.spawn(createConfig());
      expect(() => bridge.spawn(createConfig())).toThrow('already has an active worker');
    });
  });

  // ---------------------------------------------------------------------------
  // Message relay
  // ---------------------------------------------------------------------------

  describe('message relay', () => {
    it('emits log events from worker log messages', () => {
      const handler = vi.fn();
      bridge.on('log', handler);
      bridge.spawn(createConfig());

      const msg: WorkerMessage = { type: 'log', taskId: 'task-123', data: 'hello', projectId: 'proj-456' };
      getWorker().emit('message', msg);

      expect(handler).toHaveBeenCalledWith('task-123', 'hello', 'proj-456');
    });

    it('emits error events from worker error messages', () => {
      const handler = vi.fn();
      bridge.on('error', handler);
      bridge.spawn(createConfig());

      const msg: WorkerMessage = { type: 'error', taskId: 'task-123', data: 'fail', projectId: 'proj-456' };
      getWorker().emit('message', msg);

      expect(handler).toHaveBeenCalledWith('task-123', 'fail', 'proj-456');
    });

    it('emits execution-progress events from worker progress messages', () => {
      const handler = vi.fn();
      bridge.on('execution-progress', handler);
      bridge.spawn(createConfig());

      const progressData = { phase: 'building' as const, phaseProgress: 50, overallProgress: 25 };
      const msg: WorkerMessage = { type: 'execution-progress', taskId: 'task-123', data: progressData as never, projectId: 'proj-456' };
      getWorker().emit('message', msg);

      expect(handler).toHaveBeenCalledWith('task-123', progressData, 'proj-456');
    });

    it('moves the progress tracker to the phase the worker reports', () => {
      bridge.spawn(createConfig());

      const progressData = { phase: 'qa_review' as const, phaseProgress: 0, overallProgress: 0, message: 'Running QA' };
      const msg: WorkerMessage = { type: 'execution-progress', taskId: 'task-123', data: progressData as never, projectId: 'proj-456' };
      getWorker().emit('message', msg);

      expect(mockForcePhase).toHaveBeenCalledWith('qa_review', 'Running QA', undefined);
    });

    it('feeds stream-events to progress tracker and emits progress', () => {
      const handler = vi.fn();
      bridge.on('execution-progress', handler);
      bridge.spawn(createConfig());

      const streamEvent = { type: 'tool-call' as const, toolName: 'bash', args: {} };
      const msg: WorkerMessage = { type: 'stream-event', taskId: 'task-123', data: streamEvent as never, projectId: 'proj-456' };
      getWorker().emit('message', msg);

      expect(mockProcessEvent).toHaveBeenCalledWith(streamEvent);
      expect(handler).toHaveBeenCalled();
    });

    it('emits log for text-delta stream events', () => {
      const handler = vi.fn();
      bridge.on('log', handler);
      bridge.spawn(createConfig());

      const streamEvent = { type: 'text-delta' as const, text: 'some output' };
      const msg: WorkerMessage = { type: 'stream-event', taskId: 'task-123', data: streamEvent as never };
      getWorker().emit('message', msg);

      expect(handler).toHaveBeenCalledWith('task-123', 'some output', undefined);
    });
  });

  // ---------------------------------------------------------------------------
  // Result handling
  // ---------------------------------------------------------------------------

  describe('result handling', () => {
    it('maps completed outcome to exit code 0', () => {
      const exitHandler = vi.fn();
      bridge.on('exit', exitHandler);
      bridge.spawn(createConfig());

      const result = createSessionResult({ outcome: 'completed' });
      const msg: WorkerMessage = { type: 'result', taskId: 'task-123', data: result, projectId: 'proj-456' };
      getWorker().emit('message', msg);

      expect(exitHandler).toHaveBeenCalledWith('task-123', 0, 'task-execution', 'proj-456');
      expect(bridge.isActive).toBe(false);
    });

    it('maps max_steps outcome to exit code 0', () => {
      const exitHandler = vi.fn();
      bridge.on('exit', exitHandler);
      bridge.spawn(createConfig());

      const result = createSessionResult({ outcome: 'max_steps' });
      getWorker().emit('message', { type: 'result', taskId: 'task-123', data: result });

      expect(exitHandler).toHaveBeenCalledWith('task-123', 0, 'task-execution', undefined);
    });

    it('maps error outcome to exit code 1', () => {
      const exitHandler = vi.fn();
      bridge.on('exit', exitHandler);
      bridge.on('error', vi.fn()); // Prevent unhandled error throw
      bridge.on('log', vi.fn());
      bridge.spawn(createConfig());

      const result = createSessionResult({ outcome: 'error', error: { message: 'boom', code: 'unknown', retryable: false } });
      getWorker().emit('message', { type: 'result', taskId: 'task-123', data: result });

      expect(exitHandler).toHaveBeenCalledWith('task-123', 1, 'task-execution', undefined);
    });

    it('emits error event when result has an error', () => {
      const errorHandler = vi.fn();
      bridge.on('error', errorHandler);
      bridge.spawn(createConfig());

      const result = createSessionResult({ outcome: 'error', error: { message: 'boom', code: 'unknown', retryable: false } });
      getWorker().emit('message', { type: 'result', taskId: 'task-123', data: result });

      expect(errorHandler).toHaveBeenCalledWith('task-123', 'boom', undefined);
    });

    it('logs summary before exit', () => {
      const logHandler = vi.fn();
      bridge.on('log', logHandler);
      bridge.spawn(createConfig());

      const result = createSessionResult();
      getWorker().emit('message', { type: 'result', taskId: 'task-123', data: result });

      expect(logHandler).toHaveBeenCalledWith(
        'task-123',
        expect.stringContaining('Session complete'),
        undefined,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Worker crash handling
  // ---------------------------------------------------------------------------

  describe('crash handling', () => {
    it('emits error and cleans up on worker error event', () => {
      const errorHandler = vi.fn();
      bridge.on('error', errorHandler);
      bridge.spawn(createConfig());

      getWorker().emit('error', new Error('Worker crashed'));

      expect(errorHandler).toHaveBeenCalledWith('task-123', 'Worker crashed', 'proj-456');
      expect(bridge.isActive).toBe(false);
    });

    // zeenha fork: a worker that crashes (for example at import) raises 'error'
    // and then 'exit'. Exit must be reported exactly once or the task never ends.
    it('reports exit 1 exactly once when the worker crashes', () => {
      const exitHandler = vi.fn();
      bridge.on('error', vi.fn());
      bridge.on('exit', exitHandler);
      bridge.spawn(createConfig());
      const worker = getWorker();

      worker.emit('error', new Error('Worker crashed'));
      worker.emit('exit', 1);

      expect(exitHandler).toHaveBeenCalledTimes(1);
      expect(exitHandler).toHaveBeenCalledWith('task-123', 1, 'task-execution', 'proj-456');
    });

    it('emits exit on worker exit event (non-zero code)', () => {
      const exitHandler = vi.fn();
      bridge.on('exit', exitHandler);
      bridge.spawn(createConfig());

      getWorker().emit('exit', 1);

      expect(exitHandler).toHaveBeenCalledWith('task-123', 1, 'task-execution', 'proj-456');
      expect(bridge.isActive).toBe(false);
    });

    // zeenha fork: a session that throws posts 'error' and never a 'result'.
    // The task used to stay "running" forever.
    it('treats a worker error message as a failed session: exit 1, memory finalized, thread ended', () => {
      const exitHandler = vi.fn();
      bridge.on('exit', exitHandler);
      bridge.on('error', vi.fn());
      bridge.spawn(createConfig());
      const worker = getWorker();

      worker.emit('message', { type: 'error', taskId: 'task-123', data: 'Agent session failed: boom', projectId: 'proj-456' });

      expect(exitHandler).toHaveBeenCalledWith('task-123', 1, 'task-execution', 'proj-456');
      expect(bridge.isActive).toBe(false);
      expect(handlerInstances.at(-1)?.finalize).toHaveBeenCalledWith('failure');
      vi.advanceTimersByTime(WORKER_EXIT_GRACE_MS);
      expect(worker.terminate).toHaveBeenCalled();
    });

    // zeenha fork: the thread does not end by itself after its session, so
    // only dropping the reference leaked a live thread per finished session.
    it('ends the worker thread after a grace period once its result is handled', () => {
      bridge.spawn(createConfig());
      const worker = getWorker();

      worker.emit('message', { type: 'result', taskId: 'task-123', data: createSessionResult() });

      // run()'s finally (MCP clients) still gets to run first
      vi.advanceTimersByTime(WORKER_EXIT_GRACE_MS - 1);
      expect(worker.terminate).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(worker.terminate).toHaveBeenCalled();
    });

    it('does not terminate a worker that already exited on its own', () => {
      bridge.spawn(createConfig());
      const worker = getWorker();

      worker.emit('message', { type: 'result', taskId: 'task-123', data: createSessionResult() });
      worker.emit('exit', 0);
      vi.advanceTimersByTime(WORKER_EXIT_GRACE_MS);

      expect(worker.terminate).not.toHaveBeenCalled();
    });

    it('does not emit exit if worker reference already cleaned up (result already handled)', () => {
      const exitHandler = vi.fn();
      bridge.on('exit', exitHandler);
      bridge.spawn(createConfig());

      // Simulate result handling first (which cleans up)
      const worker = getWorker();
      const result = createSessionResult();
      worker.emit('message', { type: 'result', taskId: 'task-123', data: result });
      exitHandler.mockClear();

      // Then worker exits - should not double-emit
      worker.emit('exit', 0);
      expect(exitHandler).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Termination
  // ---------------------------------------------------------------------------

  describe('terminate', () => {
    it('posts abort message and terminates worker', async () => {
      bridge.spawn(createConfig());
      const worker = getWorker();

      await bridge.terminate();

      expect(worker.postMessage).toHaveBeenCalledWith({ type: 'abort' });
      expect(worker.terminate).toHaveBeenCalled();
      expect(bridge.isActive).toBe(false);
    });

    it('handles termination when no worker is active', async () => {
      await expect(bridge.terminate()).resolves.toBeUndefined();
    });

    it('handles postMessage failure on dead worker', async () => {
      bridge.spawn(createConfig());
      getWorker().postMessage.mockImplementation(() => {
        throw new Error('Worker already dead');
      });

      await expect(bridge.terminate()).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Memory channel (zeenha fork)
  // ---------------------------------------------------------------------------

  describe('memory channel', () => {
    type MemWorker = EventEmitter & { workerData: { memoryPort?: unknown }; transferList?: unknown[] };

    it('transfers a dedicated port and scopes the handler to the project', () => {
      bridge.spawn(createConfig());
      const w = getWorker() as unknown as MemWorker;

      expect(w.workerData.memoryPort).toBeDefined();
      expect(w.transferList).toEqual([w.workerData.memoryPort]);
      expect(handlerInstances).toHaveLength(1);
      expect(handlerInstances[0].options).toMatchObject({ projectId: 'proj-456', sessionType: 'build' });
      expect(handlerInstances[0].attach).toHaveBeenCalledTimes(1);
      (w.workerData.memoryPort as { close: () => void }).close();
    });

    it('opens no channel when memory is switched off', () => {
      memoryState.enabled = false;
      bridge.spawn(createConfig());
      const w = getWorker() as unknown as MemWorker;

      expect(w.workerData.memoryPort).toBeUndefined();
      expect(w.transferList).toBeUndefined();
      expect(handlerInstances).toHaveLength(0);
    });

    it('opens no channel for a directory outside every known project', () => {
      bridge.spawn(createConfig({ projectId: undefined, session: { ...createConfig().session, projectDir: '/elsewhere' } }));
      expect((getWorker() as unknown as MemWorker).workerData.memoryPort).toBeUndefined();
    });

    it('resolves the project from a task worktree when no id is given', () => {
      const worktree = '/project/.auto-claude/worktrees/tasks/007-x';
      bridge.spawn(createConfig({ projectId: undefined, session: { ...createConfig().session, projectDir: worktree } }));

      expect(handlerInstances[0].options.projectId).toBe('proj-456');
      expect(handlerInstances[0].options.roots).toEqual([worktree, '/project']);
      ((getWorker() as unknown as MemWorker).workerData.memoryPort as { close: () => void }).close();
    });

    it('finalizes once with the session outcome', () => {
      bridge.spawn(createConfig());
      const w = getWorker();
      w.emit('message', { type: 'result', taskId: 'task-123', data: createSessionResult({ outcome: 'max_steps' }) });
      w.emit('exit', 0);

      expect(handlerInstances[0].finalize).toHaveBeenCalledTimes(1);
      expect(handlerInstances[0].finalize).toHaveBeenCalledWith('partial');
    });

    it('finalizes as abandoned when terminated', async () => {
      bridge.spawn(createConfig());
      await bridge.terminate();
      expect(handlerInstances[0].finalize).toHaveBeenCalledWith('abandoned');
    });
  });
});
