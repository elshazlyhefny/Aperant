/**
 * Worker Bridge
 * =============
 *
 * Main-thread bridge that spawns a Worker thread and relays `postMessage()`
 * events to an EventEmitter matching the `AgentManagerEvents` interface.
 *
 * This allows the existing agent management system (agent-process.ts,
 * agent-events.ts) to consume worker thread events transparently — the UI
 * cannot distinguish between a Python subprocess and a TS worker thread.
 */

import { Worker, MessageChannel } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';
import { app } from 'electron';

import type { AgentManagerEvents, ExecutionProgressData, ProcessType } from '../../agent/types';
import type { TaskEventPayload } from '../../agent/task-event-schema';
import type {
  WorkerConfig,
  WorkerMessage,
  AgentExecutorConfig,
} from './types';
import type { SessionResult } from '../session/types';
import { ProgressTracker } from '../session/progress-tracker';
import type { SessionOutcome as MemorySessionOutcome, SessionType as MemorySessionType } from '../memory/types';
import { MainMemoryHandler } from '../memory/ipc/main-memory-handler';
import {
  getMemoryService,
  isAgentMemoryEnabled,
} from '../../ipc-handlers/context/memory-service-factory';
import { projectStore } from '../../project-store';

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// Worker Path Resolution
// =============================================================================

/**
 * Resolve the path to the worker entry point.
 * Handles both dev (source via electron-vite) and production (bundled) paths.
 */
function resolveWorkerPath(): string {
  if (app.isPackaged) {
    // Production: worker is inside app.asar at out/main/ai/agent/worker.js
    return path.join(process.resourcesPath, 'app.asar', 'out', 'main', 'ai', 'agent', 'worker.js');
  }
  // Dev: electron-vite outputs worker at out/main/ai/agent/worker.js
  // because the Rollup input key is 'ai/agent/worker'.
  // __dirname resolves to out/main/ at runtime, so we need the subdirectory.
  return path.join(__dirname, 'ai', 'agent', 'worker.js');
}

// =============================================================================
// WorkerBridge
// =============================================================================

/**
 * Bridges a worker thread to the AgentManagerEvents interface.
 *
 * Usage:
 * ```ts
 * const bridge = new WorkerBridge();
 * bridge.on('log', (taskId, log) => { ... });
 * bridge.on('exit', (taskId, code, processType) => { ... });
 * await bridge.spawn(config);
 * ```
 */
export class WorkerBridge extends EventEmitter {
  private worker: Worker | null = null;
  private progressTracker: ProgressTracker = new ProgressTracker();
  private taskId: string = '';
  private projectId: string | undefined;
  private processType: ProcessType = 'task-execution';
  private memoryHandler: MainMemoryHandler | null = null;

  /**
   * Spawn a worker thread with the given configuration.
   * The worker will immediately begin executing the agent session.
   *
   * @param config - Executor configuration (task ID, session params, etc.)
   */
  spawn(config: AgentExecutorConfig): void {
    if (this.worker) {
      throw new Error('WorkerBridge already has an active worker. Call terminate() first.');
    }

    this.taskId = config.taskId;
    this.projectId = config.projectId;
    this.processType = config.processType;
    this.progressTracker = new ProgressTracker();

    const workerConfig: WorkerConfig = {
      taskId: config.taskId,
      projectId: config.projectId,
      processType: config.processType,
      session: config.session,
    };

    const workerPath = resolveWorkerPath();

    // zeenha fork: give the worker a dedicated port to the main-thread memory
    // handler, so its record_memory / search_memory tools and the observer work.
    const memoryPort = this.startMemory(config);

    this.worker = new Worker(workerPath, {
      workerData: memoryPort ? { ...workerConfig, memoryPort } : workerConfig,
      transferList: memoryPort ? [memoryPort] : undefined,
    });

    this.worker.on('message', (message: WorkerMessage) => {
      this.handleWorkerMessage(message);
    });

    this.worker.on('error', (error: Error) => {
      this.finalizeMemory('failure');
      this.emitTyped('error', this.taskId, error.message, this.projectId);
      this.cleanup();
    });

    this.worker.on('exit', (code: number) => {
      // Code 0 = clean exit; non-zero = crash/error
      // Only emit exit if we haven't already emitted from a 'result' message
      if (this.worker) {
        this.finalizeMemory(code === 0 ? 'partial' : 'failure');
        this.emitTyped('exit', this.taskId, code === 0 ? 0 : code, this.processType, this.projectId);
        this.cleanup();
      }
    });
  }

  /**
   * Terminate the worker thread.
   * Sends an abort message first for graceful shutdown, then terminates.
   */
  async terminate(): Promise<void> {
    if (!this.worker) return;

    this.finalizeMemory('abandoned');

    // Try graceful abort first
    try {
      this.worker.postMessage({ type: 'abort' });
    } catch {
      // Worker may already be dead
    }

    // Force terminate after a short grace period
    const worker = this.worker;
    this.cleanup();

    try {
      await worker.terminate();
    } catch {
      // Already terminated
    }
  }

  /** Whether the worker is currently active */
  get isActive(): boolean {
    return this.worker !== null;
  }

  /** Get the underlying Worker instance (for advanced use) */
  get workerInstance(): Worker | null {
    return this.worker;
  }

  // ===========================================================================
  // Message Handling
  // ===========================================================================

  private handleWorkerMessage(message: WorkerMessage): void {
    switch (message.type) {
      case 'log':
        this.emitTyped('log', message.taskId, message.data, message.projectId);
        break;

      case 'error':
        this.emitTyped('error', message.taskId, message.data, message.projectId);
        break;

      case 'execution-progress':
        this.emitTyped('execution-progress', message.taskId, message.data, message.projectId);
        break;

      case 'stream-event':
        // Feed the progress tracker and emit progress updates
        this.progressTracker.processEvent(message.data);
        this.emitProgressFromTracker(message.taskId, message.projectId);
        // Also forward raw log for text events
        if (message.data.type === 'text-delta') {
          this.emitTyped('log', message.taskId, message.data.text, message.projectId);
        }
        break;

      case 'task-event':
        this.emitTyped('task-event', message.taskId, message.data as TaskEventPayload, message.projectId);
        break;

      case 'result':
        this.handleResult(message.taskId, message.data, message.projectId);
        break;
    }
  }

  /**
   * Convert ProgressTracker state into an ExecutionProgressData event
   * and emit it to listeners.
   */
  private emitProgressFromTracker(taskId: string, projectId?: string): void {
    const state = this.progressTracker.state;
    const progressData: ExecutionProgressData = {
      phase: state.currentPhase,
      phaseProgress: 0, // Detailed progress calculated by UI from phase
      overallProgress: 0,
      currentSubtask: state.currentSubtask ?? undefined,
      message: state.currentMessage,
      completedPhases: state.completedPhases as ExecutionProgressData['completedPhases'],
    };
    this.emitTyped('execution-progress', taskId, progressData, projectId);
  }

  /**
   * Handle the final session result from the worker.
   * Maps SessionResult.outcome to an exit code.
   */
  private handleResult(taskId: string, result: SessionResult, projectId?: string): void {
    // Map outcome to exit code
    const exitCode = result.outcome === 'completed' || result.outcome === 'max_steps' || result.outcome === 'context_window' ? 0 : 1;

    // Log the result summary
    const summary = `Session complete: outcome=${result.outcome}, steps=${result.stepsExecuted}, tools=${result.toolCallCount}, duration=${result.durationMs}ms`;
    this.emitTyped('log', taskId, summary, projectId);

    if (result.error) {
      this.emitTyped('error', taskId, result.error.message, projectId);
    }

    this.finalizeMemory(toMemoryOutcome(result.outcome));

    // Emit exit and cleanup
    this.emitTyped('exit', taskId, exitCode, this.processType, projectId);
    this.cleanup();
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /**
   * Type-safe emit that matches AgentManagerEvents signatures.
   */
  private emitTyped<K extends keyof AgentManagerEvents>(
    event: K,
    ...args: Parameters<AgentManagerEvents[K]>
  ): void {
    this.emit(event, ...args);
  }

  private cleanup(): void {
    this.worker = null;
  }

  // ===========================================================================
  // Memory (zeenha fork)
  // ===========================================================================

  /**
   * Create the main-thread memory handler and return the worker's end of its
   * port, or null when memory is off or the project cannot be identified.
   * Never throws: a memory problem must not stop the agent from running.
   */
  private startMemory(config: AgentExecutorConfig): import('worker_threads').MessagePort | null {
    try {
      if (!isAgentMemoryEnabled()) return null;
      const projectDir = config.session.projectDir;
      const project = resolveProject(config.projectId, projectDir);
      if (!project) return null;

      const { port1, port2 } = new MessageChannel();
      const handler = new MainMemoryHandler({
        sessionId: `${config.taskId}:${Date.now()}`,
        sessionType: toMemorySessionType(config.processType),
        projectId: project.id,
        roots: [projectDir, project.path].filter((r): r is string => !!r),
        getService: getMemoryService,
        log: (message) => console.info(`[WorkerBridge:${config.taskId}] ${message}`),
      });
      handler.attach(port1);
      this.memoryHandler = handler;
      return port2;
    } catch (error) {
      console.warn('[WorkerBridge] memory disabled for this worker:', error);
      return null;
    }
  }

  private finalizeMemory(outcome: MemorySessionOutcome): void {
    const handler = this.memoryHandler;
    if (!handler) return;
    this.memoryHandler = null;
    void handler.finalize(outcome);
  }
}

function resolveProject(projectId: string | undefined, projectDir: string): { id: string; path: string } | null {
  const projects = projectStore.getProjects();
  const byId = projectId ? projects.find((p) => p.id === projectId) : undefined;
  if (byId) return byId;
  // Task workers run in a worktree under the project, so match by prefix.
  const dir = projectDir.replace(/\\/g, '/');
  return (
    projects.find((p) => {
      const root = p.path.replace(/\\/g, '/').replace(/\/+$/, '');
      return dir === root || dir.startsWith(`${root}/`);
    }) ?? null
  );
}

function toMemorySessionType(processType: ProcessType): MemorySessionType {
  return processType === 'spec-creation' ? 'spec_creation' : 'build';
}

function toMemoryOutcome(outcome: SessionResult['outcome']): MemorySessionOutcome {
  switch (outcome) {
    case 'completed':
      return 'success';
    case 'max_steps':
    case 'context_window':
      return 'partial';
    case 'cancelled':
      return 'abandoned';
    default:
      return 'failure';
  }
}
