/**
 * zeenha fork: run one executor config on a worker bridge and collect what
 * happened, for the headless runners. Free of electron imports.
 */

import type { EventEmitter } from 'node:events';

import type { ExecutionProgressData } from '../agent/types';
import type { AgentExecutorConfig } from '../ai/agent/types';
import type { RunEvent, RunInput } from './outcome';
import type { ProgressReporter } from './progress';

/** What the runner needs from a worker bridge (WorkerBridgeCore satisfies it). */
export interface HeadlessBridge extends EventEmitter {
  spawn(config: AgentExecutorConfig): void;
  terminate(): Promise<void>;
}

export interface BridgeRunOptions {
  bridge: HeadlessBridge;
  executorConfig: AgentExecutorConfig;
  reporter: ProgressReporter;
  /** Aborting behaves like SIGTERM: the bridge is terminated. */
  signal?: AbortSignal;
  /** Register SIGINT/SIGTERM handlers (default true). The daemon passes false. */
  handleProcessSignals?: boolean;
}

export function collectBridgeRun(options: BridgeRunOptions): Promise<RunInput> {
  const { bridge, executorConfig, reporter, signal } = options;
  const handleProcessSignals = options.handleProcessSignals !== false;
  const events: RunEvent[] = [];
  const errors: string[] = [];
  let exitInfo: { code: number | null; signal?: string | null } | undefined;
  let abortSignal: string | undefined;

  return new Promise<RunInput>((resolve) => {
    let settled = false;
    const onSigint = () => abort('SIGINT');
    const onSigterm = () => abort('SIGTERM');
    const onAbortSignal = () => {
      const reason = signal?.reason;
      abort(typeof reason === 'string' && reason ? reason : 'abort signal');
    };
    const removeHandlers = () => {
      if (handleProcessSignals) {
        process.off('SIGINT', onSigint);
        process.off('SIGTERM', onSigterm);
      }
      signal?.removeEventListener('abort', onAbortSignal);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      removeHandlers();
      resolve({ events, errors, exit: exitInfo, abortSignal });
    };

    bridge.on('log', (_taskId: string, text: string) => reporter.log(text));
    bridge.on('execution-progress', (_taskId: string, data: ExecutionProgressData) => reporter.progress(data));
    bridge.on('task-event', (_taskId: string, event: RunEvent) => {
      events.push(event);
      reporter.taskEvent(event);
    });
    bridge.on('error', (_taskId: string, message: string) => {
      errors.push(message);
      reporter.error(message);
    });
    bridge.on('exit', (_taskId: string, code: number | null) => {
      exitInfo = { code };
      finish();
    });

    const abort = (signal: string) => {
      if (abortSignal) return;
      abortSignal = signal;
      Promise.resolve(bridge.terminate())
        .catch(() => {
          // Already gone
        })
        .finally(finish);
    };
    if (handleProcessSignals) {
      process.on('SIGINT', onSigint);
      process.on('SIGTERM', onSigterm);
    }

    try {
      bridge.spawn(executorConfig);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      finish();
      return;
    }
    // Registered after spawn so an already-aborted signal terminates a live bridge.
    if (signal) {
      if (signal.aborted) onAbortSignal();
      else signal.addEventListener('abort', onAbortSignal, { once: true });
    }
  });
}
