/**
 * zeenha fork: the roadmap queue brings the checkout up to date first and hands
 * the runner the project's tasks. Tested here because the runner tests alone
 * would pass with this wiring dropped.
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  order: [] as string[],
  configs: [] as Array<{ checkoutNote?: string; priorWorkNote?: string }>,
  update: { kind: 'current' } as Record<string, unknown>,
}));

vi.mock('../ai/runners/roadmap', () => ({
  runRoadmapGeneration: vi.fn(async (config: (typeof calls.configs)[number]) => {
    calls.order.push('roadmap');
    calls.configs.push(config);
    return { success: false, phases: [], error: 'stopped by the test' };
  }),
}));
vi.mock('../ideation-freshness', () => ({
  findUnpulledCommits: vi.fn(),
  fastForwardCheckout: vi.fn(async () => {
    calls.order.push('update');
    return calls.update;
  }),
  checkoutUpdateLog: (u: { kind: string }) => (u.kind === 'current' ? null : `LOG ${u.kind}`),
  unpulledCommitsNote: () => 'CHECKOUT NOTE: 66 behind origin/main',
}));

import { AgentQueueManager } from './agent-queue';

let project: string;
beforeEach(() => {
  calls.order.length = 0;
  calls.configs.length = 0;
  project = mkdtempSync(path.join(tmpdir(), 'queue-roadmap-'));
  const spec = path.join(project, '.auto-claude', 'specs', '044-draft-stock-orders');
  mkdirSync(spec, { recursive: true });
  writeFileSync(path.join(spec, 'spec.md'), '# Draft stock orders from low-stock products\n');
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

const stub = () => new Proxy({}, { get: (_t, key) => (key === 'generateSpawnId' ? () => 1 : vi.fn()) });

async function run() {
  const emitter = new EventEmitter();
  const logs: string[] = [];
  emitter.on('roadmap-log', (_id: string, line: string) => logs.push(line));
  const queue = new AgentQueueManager(stub() as never, stub() as never, stub() as never, emitter);
  await queue.startRoadmapGeneration('p1', project, true, false, false);
  return logs;
}

describe('roadmap queue context', () => {
  it('updates the checkout before the run, and lists the project tasks', async () => {
    calls.update = { kind: 'pulled', upstream: 'origin/main', count: 66, from: 'c609e38f', to: 'ef5719fe' };

    const logs = await run();

    expect(calls.order).toEqual(['update', 'roadmap']);
    expect(logs).toContain('LOG pulled');
    expect(calls.configs[0].checkoutNote).toBeUndefined(); // pulled: nothing is missing
    expect(calls.configs[0].priorWorkNote).toContain('- 044-draft-stock-orders: Draft stock orders from low-stock products');
  });

  it('tells the agents what is missing when the checkout could not be updated', async () => {
    calls.update = { kind: 'behind', reason: 'it has uncommitted changes', unpulled: { upstream: 'origin/main', count: 66, subjects: [] } };

    const logs = await run();

    expect(logs).toContain('LOG behind');
    expect(calls.configs[0].checkoutNote).toBe('CHECKOUT NOTE: 66 behind origin/main');
  });
});
