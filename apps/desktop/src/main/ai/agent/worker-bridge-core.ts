/**
 * Worker Bridge Core
 * ==================
 *
 * zeenha fork: the Electron-free part of WorkerBridge. The headless CLI runs
 * agents without Electron, so the spawn / message-relay / exit logic lives here
 * with no electron, project-store or memory-service-factory imports. The caller
 * supplies the worker path (never computed from this file's import.meta.url,
 * because rollup may place this module in a shared chunk) and, optionally, the
 * memory wiring.
 */

import { Worker } from 'worker_threads';
import type { MessagePort } from 'worker_threads';
import { EventEmitter } from 'events';

import type { AgentManagerEvents, ExecutionProgressData, ProcessType } from '../../agent/types';
import type { TaskEventPayload } from '../../agent/task-event-schema';
import type {
  WorkerConfig,
  WorkerMessage,
  AgentExecutorConfig,
} from './types';
import { TOKEN_BUDGET_ERROR_CODE, type SessionResult } from '../session/types';
import { ProgressTracker } from '../session/progress-tracker';
import type { SessionOutcome as MemorySessionOutcome } from '../memory/types';

/** The part of the memory handler the bridge needs. */
export interface MemoryHandlerLike {
  finalize(outcome: MemorySessionOutcome): unknown;
}

export interface WorkerBridgeCoreOptions {
  /** Returns the absolute path of the worker entry point. */
  resolveWorkerPath: () => string;
  /** Optional memory wiring; when absent the worker gets no memoryPort. */
  startMemory?: (config: AgentExecutorConfig) => { port: MessagePort; handler: MemoryHandlerLike } | null;
}

/** zeenha fork: how long a finished worker may run its own cleanup before it is terminated. */
export const WORKER_EXIT_GRACE_MS = 10_000;

export class WorkerBridgeCore extends EventEmitter {
  private worker: Worker | null = null;
  private progressTracker: ProgressTracker = new ProgressTracker();
  private taskId: string = '';
  private projectId: string | undefined;
  private processType: ProcessType = 'task-execution';
  private memoryHandler: MemoryHandlerLike | null = null;

  constructor(private readonly options: WorkerBridgeCoreOptions) {
    super();
  }

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

    const workerPath = this.options.resolveWorkerPath();

    // zeenha fork: give the worker a dedicated port to the main-thread memory
    // handler, so its record_memory / search_memory tools and the observer work.
    const memory = this.options.startMemory?.(config) ?? null;
    const memoryPort = memory?.port ?? null;
    this.memoryHandler = memory?.handler ?? null;

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
      // zeenha fork: cleanup() clears this.worker, so the 'exit' handler below
      // stays silent after a crash. Without this exit the task stayed "running"
      // forever and kept its queue slot.
      this.emitTyped('exit', this.taskId, 1, this.processType, this.projectId);
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
        // zeenha fork: the worker posts 'error' only from run()'s catch, i.e.
        // the session threw and no 'result' will follow. The thread does not
        // end on its own (its parentPort 'message' listener keeps it alive), so
        // without this the task stayed "running" forever: no exit, no memory
        // finalize. Treat it as a failed session.
        if (this.worker) {
          this.finalizeMemory('failure');
          this.emitTyped('exit', message.taskId, 1, this.processType, message.projectId);
          this.releaseWorker();
        }
        break;

      case 'execution-progress':
        // zeenha fork: the orchestrator owns the phase. Without this the tracker
        // never left the phase it guessed from early text, and every stream
        // event re-persisted it, moving a task in QA back to in_progress.
        this.progressTracker.forcePhase(
          message.data.phase,
          message.data.message ?? '',
          message.data.currentSubtask,
        );
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
    // zeenha fork: a token budget pause is a clean stop, not a failure. The
    // worker already posted TOKEN_BUDGET_REACHED, so no exit error or toast.
    const budgetPause = result.error?.code === TOKEN_BUDGET_ERROR_CODE;
    const exitCode = budgetPause || result.outcome === 'completed' || result.outcome === 'max_steps' || result.outcome === 'context_window' ? 0 : 1;

    // Log the result summary
    const summary = `Session complete: outcome=${result.outcome}, steps=${result.stepsExecuted}, tools=${result.toolCallCount}, duration=${result.durationMs}ms`;
    this.emitTyped('log', taskId, summary, projectId);

    if (budgetPause && result.error) {
      this.emitTyped('log', taskId, result.error.message, projectId);
    } else if (result.error) {
      this.emitTyped('error', taskId, result.error.message, projectId);
    }

    this.finalizeMemory(toMemoryOutcome(result.outcome));

    // Emit exit and cleanup
    this.emitTyped('exit', taskId, exitCode, this.processType, projectId);
    this.releaseWorker();
  }

  /**
   * zeenha fork: drop the worker AND end its thread. A worker thread never
   * exits by itself once its session is over (the abort listener on
   * parentPort keeps its event loop alive), so only nulling the reference
   * leaked one live thread, with its whole module graph, per finished session.
   * The thread still has cleanup to run after it reports (run()'s finally
   * closes its MCP clients, which may be child processes), so it gets a grace
   * period before it is terminated.
   */
  private releaseWorker(): void {
    const worker = this.worker;
    this.cleanup();
    if (!worker) return;
    const timer = setTimeout(() => {
      try {
        void Promise.resolve(worker.terminate()).catch(() => {
          // Already gone
        });
      } catch {
        // Already gone
      }
    }, WORKER_EXIT_GRACE_MS);
    timer.unref?.();
    worker.once('exit', () => clearTimeout(timer));
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

  private finalizeMemory(outcome: MemorySessionOutcome): void {
    const handler = this.memoryHandler;
    if (!handler) return;
    this.memoryHandler = null;
    void handler.finalize(outcome);
  }
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
