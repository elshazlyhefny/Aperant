import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

import type { AgentExecutorConfig } from '../types';
import type { SessionResult } from '../../session/types';
import { WorkerBridgeCore } from '../worker-bridge-core';

const createdWorkers: (EventEmitter & { workerData?: unknown })[] = [];

vi.mock('worker_threads', () => {
  const { EventEmitter: EE } = require('events') as typeof import('events');
  class MockWorker extends EE {
    postMessage = vi.fn();
    terminate = vi.fn().mockResolvedValue(0);
    workerData: unknown;
    constructor(_path: string, opts?: { workerData?: unknown }) {
      super();
      this.workerData = opts?.workerData;
      createdWorkers.push(this);
    }
  }
  return { Worker: MockWorker };
});

const config = {
  taskId: 'task-1',
  projectId: 'proj-1',
  processType: 'task-execution',
  session: { projectDir: '/tmp/p' },
} as unknown as AgentExecutorConfig;

function result(outcome: SessionResult['outcome']): SessionResult {
  return { outcome, stepsExecuted: 1, toolCallCount: 0, durationMs: 1 } as unknown as SessionResult;
}

describe('WorkerBridgeCore', () => {
  beforeEach(() => {
    createdWorkers.length = 0;
  });

  it.each([
    ['completed', 0],
    ['max_steps', 0],
    ['context_window', 0],
    ['error', 1],
  ] as const)('maps outcome %s to exit code %i', (outcome, code) => {
    const resolveWorkerPath = vi.fn(() => '/worker.js');
    const bridge = new WorkerBridgeCore({ resolveWorkerPath });
    const onExit = vi.fn();
    bridge.on('exit', onExit);
    bridge.spawn(config);
    expect(resolveWorkerPath).toHaveBeenCalled();
    createdWorkers[0].emit('message', { type: 'result', taskId: 'task-1', projectId: 'proj-1', data: result(outcome) });
    expect(onExit).toHaveBeenCalledWith('task-1', code, 'task-execution', 'proj-1');
  });

  it('emits exit 1 on an error message', () => {
    const bridge = new WorkerBridgeCore({ resolveWorkerPath: () => '/worker.js' });
    const onExit = vi.fn();
    bridge.on('error', () => {});
    bridge.on('exit', onExit);
    bridge.spawn(config);
    createdWorkers[0].emit('message', { type: 'error', taskId: 'task-1', projectId: 'proj-1', data: 'boom' });
    expect(onExit).toHaveBeenCalledWith('task-1', 1, 'task-execution', 'proj-1');
  });

  it('sends no memoryPort without startMemory', () => {
    const bridge = new WorkerBridgeCore({ resolveWorkerPath: () => '/worker.js' });
    bridge.spawn(config);
    expect(createdWorkers[0].workerData).not.toHaveProperty('memoryPort');
  });
});
