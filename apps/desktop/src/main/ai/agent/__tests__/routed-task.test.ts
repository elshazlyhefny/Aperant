import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { taskAgentPreset, taskPhaseMetadata } from '../../../../shared/utils/task-agent';
import type { TaskAgentMode } from '../../../../shared/types/settings';
import type { ProviderAccount } from '../../../../shared/types/provider-account';
import type { SessionConfig } from '../../session/types';
import { type MainToWorkerMessage } from '../types';
import { phaseConnectionResolver } from '../phase-connection';
import type { AgentExecutorConfig, WorkerMessage } from '../types';

// Exercise the real bridge, worker and orchestrators. Replace the thread transport
// and model calls so the test observes the model, key and workspace without a login.
const harness = vi.hoisted(() => ({
  worker: undefined as unknown as EventEmitter,
  parent: undefined as unknown as EventEmitter,
  data: undefined as unknown,
  keys: new WeakMap<object, string | undefined>(),
  runModel: vi.fn(),
}));
vi.mock('worker_threads', async importOriginal => {
  const { EventEmitter } = await import('node:events');
  const original = await importOriginal<typeof import('worker_threads')>();
  return {
    ...original,
    get workerData() { return harness.data; },
    get parentPort() { return harness.parent; },
    Worker: class extends EventEmitter {
      constructor(_path: string, options: {workerData: unknown}) {
        super();
        harness.worker = this;
        harness.data = options.workerData;
        harness.parent = Object.assign(new EventEmitter(), {
          postMessage: (msg: WorkerMessage) => queueMicrotask(() => this.emit('message', msg)),
        });
      }
      postMessage(msg: MainToWorkerMessage) { queueMicrotask(() => harness.parent.emit('message', msg)); }
      terminate() { this.emit('exit', 0); }
    },
  };
});
vi.mock('../../providers/factory', async importOriginal => {
  const original = await importOriginal<typeof import('../../providers/factory')>();
  return { ...original, createProvider(options: Parameters<typeof original.createProvider>[0]) {
    const model = original.createProvider(options);
    if (typeof model !== 'string') harness.keys.set(model, options.config.apiKey);
    return model;
  } };
});
vi.mock('../../session/continuation', () => ({ runContinuableSession: harness.runModel }));
vi.mock('../../mcp/client', () => ({ resolveMcpServersForAgent: () => [], mergeMcpTools: () => ({}) }));
vi.mock('../../tools/build-registry', () => ({ buildToolRegistry: () => ({ getToolsForAgent: () => ({}) }) }));
vi.mock('../../project/project-indexer', () => ({ runProjectIndexer: vi.fn() }));

let dir: string;
let calls: Array<{phase: string; provider: string; model: string; key?: string}>;
const accounts: ProviderAccount[] = [];
function addAccount(provider: 'anthropic' | 'openai') {
  accounts.push({ provider, id: provider, name: provider, createdAt: 0, updatedAt: 0,
    authType: 'api-key', billingModel: 'pay-per-use', apiKey: `fixture-${provider}` });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aperant-routing-'));
  calls = [];
  accounts.length = 0;
  harness.runModel.mockImplementation(async (session: SessionConfig) => {
    if (typeof session.model === 'string') throw new Error('Expected resolved SDK model');
    calls.push({ phase: session.phase!, provider: session.model.provider, model: session.model.modelId, key: harness.keys.get(session.model) });
    expect(session.toolContext.cwd).toBe(dir);
    if (session.agentType === 'spec_writer') await writeFile(join(dir, 'spec.md'), '# Specification');
    if (session.phase === 'planning') {
      expect(await readFile(join(dir, 'spec.md'), 'utf8')).toBe('# Specification');
      await writeFile(join(dir, 'implementation_plan.json'), JSON.stringify({ feature: 'Demo',
        phases: [{ id: 'p1', name: 'Implement', subtasks: [{ id: 's1', description: 'Implement fixture', status: 'pending' }] }] }));
    }
    if (session.phase === 'coding') {
      expect(await readFile(join(dir, 'implementation_plan.json'), 'utf8')).toContain('Implement fixture');
      await writeFile(join(dir, 'change.txt'), 'Implemented');
    }
    if (session.phase === 'qa') {
      expect(await readFile(join(dir, 'change.txt'), 'utf8')).toBe('Implemented');
      await writeFile(join(dir, 'qa_report.md'), 'Status: PASSED');
    }
    return { outcome: 'completed', stepsExecuted: 1, durationMs: 1, toolCallCount: 1, messages: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function run(mode: TaskAgentMode, spec = false) {
  vi.resetModules();
  const workerExitListeners = new Set(process.rawListeners('exit'));
  const { WorkerBridgeCore } = await import('../worker-bridge-core');
  const metadata = taskPhaseMetadata(taskAgentPreset(mode, {}).phases);
  await writeFile(join(dir, 'task_metadata.json'), JSON.stringify(metadata));
  const config: AgentExecutorConfig = {
    taskId: 'test', processType: spec ? 'spec-creation' : 'task-execution',
    resolvePhaseConnection: phaseConnectionResolver(metadata, () => ({ accounts, priorityOrder: [], fallback: async () => null })),
    session: { agentType: spec ? 'spec_orchestrator' : 'build_orchestrator',
      specDir: dir, projectDir: dir, toolContext: { cwd: dir, specDir: dir, projectDir: dir },
      modelId: metadata.model, provider: metadata.provider, systemPrompt: 'Test',
      initialMessages: [{ role: 'user', content: 'Fix typo in title' }], maxSteps: 10 },
  };
  const bridge = new WorkerBridgeCore({ resolveWorkerPath: () => 'mock-thread' });
  const events: Array<{ type: string; error?: string }> = [];
  bridge.on('task-event', (_task, event) => events.push(event));
  const exit = new Promise<number>((resolve, reject) => {
    bridge.once('exit', (_task, code) => resolve(code));
    bridge.once('error', (_task, message) => reject(new Error(message)));
  });
  bridge.spawn(config);
  await import('../worker');
  try {
    return { code: await exit, events };
  } finally {
    harness.worker.emit('exit', 0);
    for (const listener of process.rawListeners('exit')) {
      if (!workerExitListeners.has(listener)) process.off('exit', listener as () => void);
    }
  }
}

it.each(['claude', 'codex', 'both'] as const)('runs a %s task from specification through QA', async mode => {
  if (mode !== 'codex') addAccount('anthropic');
  if (mode !== 'claude') addAccount('openai');
  expect((await run(mode, true)).code).toBe(0);
  expect((await run(mode)).events.map(e => e.type)).toContain('QA_PASSED');
  expect(new Set(calls.map(c => c.phase))).toEqual(new Set(['spec', 'planning', 'coding', 'qa']));
  for (const call of calls) {
    const expected = mode === 'codex' || (mode === 'both' && call.phase === 'coding') ? 'openai' : 'anthropic';
    expect(call.provider).toContain(expected);
    expect(call.key).toBe(`fixture-${expected}`);
    expect(call.model).toContain(expected === 'openai' ? 'codex' : 'claude');
  }
}, 20000);

it('pauses at coding and resumes the saved plan on Codex before Claude QA', async () => {
  addAccount('anthropic');
  await run('both', true);
  calls = [];
  const pause = await run('both');
  expect(pause.events).toContainEqual(expect.objectContaining({ type: 'PHASE_ACCOUNT_UNAVAILABLE', error: expect.stringContaining('Codex') }));
  expect(calls).toEqual([]);
  addAccount('openai');
  expect((await run('both')).code).toBe(0);
  expect(calls.map(call => call.phase)).toEqual(['coding', 'qa']);
}, 20000);

it('resumes directly at QA when coding finished before the review account became available', async () => {
  await writeFile(join(dir, 'implementation_plan.json'), JSON.stringify({ feature: 'Demo',
    phases: [{ id: 'p1', name: 'Implement', subtasks: [{ id: 's1', description: 'Implement fixture', status: 'completed' }] }] }));
  await writeFile(join(dir, 'change.txt'), 'Implemented');
  addAccount('openai');
  expect((await run('both')).events).toContainEqual(expect.objectContaining({
    type: 'PHASE_ACCOUNT_UNAVAILABLE', error: expect.stringContaining('qa'),
  }));
  addAccount('anthropic');
  expect((await run('both')).code).toBe(0);
  expect(calls.map(call => call.phase)).toEqual(['qa']);
});

it('resolves a ChatGPT subscription token for a Codex phase without a Claude account', async () => {
  const tokenFile = join(dir, 'codex-auth.json');
  await writeFile(tokenFile, JSON.stringify({access_token: 'fixture', expires_at: Date.now() + 3_600_000}));
  addAccount('openai');
  accounts[0] = { ...accounts[0], authType: 'oauth', apiKey: undefined };
  const metadata = taskPhaseMetadata(taskAgentPreset('codex', {}).phases);
  const resolve = phaseConnectionResolver(metadata, () => ({
    accounts, priorityOrder: [], codexTokenFilePath: tokenFile, fallback: async () => null,
  }));
  expect(await resolve!('coding')).toMatchObject({ provider: 'openai', oauthTokenFilePath: tokenFile, modelId: metadata.phaseModels.coding });
});
