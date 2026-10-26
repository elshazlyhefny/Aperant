/**
 * zeenha fork: the ideation queue hands every category the stale-checkout note
 * and its own prior-work note. Both were only tested at the runner, so the
 * wiring here could be dropped without any test failing.
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runs = vi.hoisted(() => [] as Array<{ ideationType: string; checkoutNote?: string; priorWorkNote?: string }>);

vi.mock('../ai/runners/ideation', () => ({
  IDEATION_TYPES: ['security_hardening', 'code_quality'],
  runIdeation: vi.fn(async (config: (typeof runs)[number]) => {
    runs.push(config);
    return { success: false, text: '', error: 'stopped by the test' };
  }),
}));
vi.mock('../ideation-freshness', () => ({
  findUnpulledCommits: vi.fn(async () => ({ upstream: 'origin/main', count: 5, subjects: ['4866a5cb Translate strings'] })),
  unpulledCommitsNote: () => 'CHECKOUT NOTE: 5 behind origin/main',
}));
vi.mock('../ai/prompts/prompt-loader', () => ({ resolvePromptsDir: () => '/prompts' }));

import { AgentQueueManager } from './agent-queue';

let project: string;
beforeEach(() => {
  runs.length = 0;
  project = mkdtempSync(path.join(tmpdir(), 'queue-ideation-'));
  const spec = path.join(project, '.auto-claude', 'specs', '007-restrict-telescope');
  mkdirSync(spec, { recursive: true });
  writeFileSync(path.join(spec, 'spec.md'), '# Restrict the Telescope gate\n');
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

// Only what runIdeationRunner touches; anything else is a no-op.
const stub = () => new Proxy({}, { get: (_t, key) => (key === 'generateSpawnId' ? () => 1 : vi.fn()) });

describe('ideation queue context', () => {
  it('gives each category the checkout note and the prior-work note for its type', async () => {
    const queue = new AgentQueueManager(stub() as never, stub() as never, stub() as never, new EventEmitter());

    await queue.startIdeationGeneration('p1', project, { enabledTypes: ['security_hardening', 'code_quality'] } as never);

    expect(runs.map((r) => r.ideationType)).toEqual(['security_hardening', 'code_quality']);
    for (const run of runs) {
      expect(run.checkoutNote).toBe('CHECKOUT NOTE: 5 behind origin/main');
      expect(run.priorWorkNote).toContain('- 007-restrict-telescope: Restrict the Telescope gate');
    }
  });
});
