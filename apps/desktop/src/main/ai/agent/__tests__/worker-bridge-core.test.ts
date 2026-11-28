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

  it('forwards a budget warning without ending the run', () => {
    const bridge = new WorkerBridgeCore({ resolveWorkerPath: () => '/worker.js' });
    const onWarning = vi.fn();
    const onExit = vi.fn();
    bridge.on('budget-warning', onWarning);
    bridge.on('exit', onExit);
    bridge.spawn(config);
    createdWorkers[0].emit('message', { type: 'budget-warning', taskId: 'task-1', projectId: 'proj-1', used: 800, limit: 1000 });
    expect(onWarning).toHaveBeenCalledWith('task-1', { used: 800, limit: 1000 }, 'proj-1');
    expect(onExit).not.toHaveBeenCalled();
  });

  // zeenha fork: rate limits are recorded on the account
  it('records a rate limit with the reset time named in the error', () => {
    const recordRateLimit = vi.fn();
    const bridge = new WorkerBridgeCore({ resolveWorkerPath: () => '/worker.js', recordRateLimit });
    bridge.on('error', vi.fn());
    bridge.spawn({ ...config, accountId: 'pa_1' } as AgentExecutorConfig);
    const resetSeconds = Math.floor(Date.now() / 1000) + 3600;
    createdWorkers[0].emit('message', {
      type: 'result', taskId: 'task-1', projectId: 'proj-1',
      data: { ...result('rate_limited'), error: { code: 'rate_limited', message: `Rate limit exceeded: usage limit reached|${resetSeconds}`, retryable: true } },
    });
    expect(recordRateLimit).toHaveBeenCalledWith('pa_1', resetSeconds * 1000);
  });

  it('records a rate limit without a reset time as null, and nothing for other outcomes', () => {
    const recordRateLimit = vi.fn();
    const bridge = new WorkerBridgeCore({ resolveWorkerPath: () => '/worker.js', recordRateLimit });
    bridge.on('error', vi.fn());
    bridge.spawn({ ...config, accountId: 'pa_1' } as AgentExecutorConfig);
    createdWorkers[0].emit('message', {
      type: 'result', taskId: 'task-1', projectId: 'proj-1',
      data: { ...result('rate_limited'), error: { code: 'rate_limited', message: '429 Too Many Requests', retryable: true } },
    });
    expect(recordRateLimit).toHaveBeenCalledWith('pa_1', null);

    const other = vi.fn();
    const second = new WorkerBridgeCore({ resolveWorkerPath: () => '/worker.js', recordRateLimit: other });
    second.spawn({ ...config, accountId: 'pa_1' } as AgentExecutorConfig);
    createdWorkers[1].emit('message', { type: 'result', taskId: 'task-1', projectId: 'proj-1', data: result('completed') });
    expect(other).not.toHaveBeenCalled();
  });

  it('records a routed phase rate limit on the phase account', async () => {
    const recordRateLimit = vi.fn();
    const resolvePhaseConnection = vi.fn(async () => ({ provider: 'anthropic', modelId: 'm', accountId: 'pa_phase' }));
    const bridge = new WorkerBridgeCore({ resolveWorkerPath: () => '/worker.js', recordRateLimit });
    bridge.spawn({ ...config, resolvePhaseConnection } as unknown as AgentExecutorConfig);
    createdWorkers[0].emit('message', { type: 'phase-connection', phase: 'planning', requestId: 1 });
    await vi.waitFor(() => expect(resolvePhaseConnection).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    createdWorkers[0].emit('message', { type: 'phase-rate-limit', resetAt: 1234 });
    expect(recordRateLimit).toHaveBeenCalledWith('pa_phase', 1234);
  });

  it('sends no memoryPort without startMemory', () => {
    const bridge = new WorkerBridgeCore({ resolveWorkerPath: () => '/worker.js' });
    bridge.spawn(config);
    expect(createdWorkers[0].workerData).not.toHaveProperty('memoryPort');
  });
});
