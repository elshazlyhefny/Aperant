/**
 * zeenha fork: six tasks failed on 2026-10-11 with "Failed planning phase" a
 * fraction of a second after the planner wrote a valid implementation plan.
 *
 * Root cause: validateAndNormalizeJsonFile() wrote the normalized plan to a
 * temp file under os.tmpdir() and rename()d it over the plan. rename() cannot
 * cross filesystems; the machine had just started mounting /tmp as a tmpfs
 * (systemd tmp.mount), so every rename threw EXDEV. The exception escaped
 * runPlanningPhase(), BuildOrchestrator.run() caught it as "Build failed", and
 * the worker posted CODING_FAILED. The plan on disk was never normalized.
 *
 * The first suite models a separate /tmp deterministically: rename() throws
 * EXDEV whenever source and target are in different directories. The second
 * runs on the real filesystem with the spec directory OUTSIDE os.tmpdir(), so
 * on a machine whose /tmp is a tmpfs it is the original failure, unmocked.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MockLanguageModelV3 } from 'ai/test';

import { ImplementationPlanOutputSchema, ImplementationPlanSchema, repairJsonWithLLM } from '../../schema';
import type { SessionResult } from '../../session/types';
import { BuildOrchestrator, type SessionRunConfig } from '../build-orchestrator';

const crossDevice = vi.hoisted(() => ({ on: false }));

function guardedRename<T extends (from: string, to: string) => Promise<void>>(real: T): T {
  return (async (from: string, to: string) => {
    if (crossDevice.on) {
      const { dirname: dir, resolve: abs } = await import('node:path');
      if (dir(abs(from)) !== dir(abs(to))) {
        const error = new Error(`EXDEV: cross-device link not permitted, rename '${from}' -> '${to}'`);
        (error as NodeJS.ErrnoException).code = 'EXDEV';
        throw error;
      }
    }
    return real(from, to);
  }) as T;
}

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: guardedRename(actual.rename) };
});
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, rename: guardedRename(actual.rename) };
});

// A plan exactly as the planner writes it: no titles, no files_to_* arrays.
const PLANNER_PLAN = {
  feature: 'Drop the casts',
  workflow_type: 'refactor',
  phases: [
    {
      id: 'phase-1',
      name: 'Baseline',
      description: 'Record the current state',
      depends_on: [],
      subtasks: [
        { id: '1.1', description: 'Record the baseline', status: 'pending' },
        { id: '1.2', description: 'Type the calls', status: 'pending' },
      ],
    },
  ],
};

// What the repair model returns: the strict Output.object() shape.
const REPAIRED_PLAN = {
  feature: 'Drop the casts',
  workflow_type: 'refactor',
  phases: [{
    id: 'phase-1',
    name: 'Baseline',
    subtasks: [{ id: '1.1', title: 'Record the baseline', description: 'Record the baseline', status: 'pending', files_to_create: [], files_to_modify: [] }],
  }],
};

const completed: SessionResult = {
  outcome: 'completed', stepsExecuted: 3, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  messages: [], durationMs: 0, toolCallCount: 1,
};
// The coder "cancels" so the build ends at once with a known error, proving it got past planning.
const coderStops: SessionResult = { ...completed, outcome: 'cancelled' };

function plannerThenCoder(specDir: string) {
  return vi.fn(async (config: SessionRunConfig) => {
    if (config.agentType === 'planner') {
      writeFileSync(join(specDir, 'implementation_plan.json'), JSON.stringify(PLANNER_PLAN, null, 2));
      return completed;
    }
    return coderStops;
  });
}

async function runBuild(specDir: string) {
  const runSession = plannerThenCoder(specDir);
  const o = new BuildOrchestrator({ specDir, projectDir: specDir, generatePrompt: async () => 'prompt', runSession });
  const outcome = await o.run();
  return { outcome, agents: runSession.mock.calls.map((c) => c[0].agentType) };
}

function readPlan(specDir: string) {
  return JSON.parse(readFileSync(join(specDir, 'implementation_plan.json'), 'utf8'));
}

describe('a valid plan when /tmp is another filesystem (EXDEV modelled)', () => {
  let specDir: string;
  beforeEach(() => {
    crossDevice.on = true;
    specDir = mkdtempSync(join(resolve(__dirname), '.xdev-spec-'));
  });
  afterEach(() => {
    crossDevice.on = false;
    rmSync(specDir, { recursive: true, force: true });
  });

  it('finishes planning and starts coding instead of failing the build', async () => {
    const { outcome, agents } = await runBuild(specDir);

    expect(outcome.error ?? '').not.toMatch(/EXDEV/);
    expect(agents[0]).toBe('planner');
    expect(agents).toContain('coder'); // planning was accepted
    expect(agents.filter((a) => a === 'planner')).toHaveLength(1); // not re-planned
    expect(outcome.error).toBe('Build cancelled');
  });

  it('writes the normalized plan back to disk and leaves no temp file behind', async () => {
    await runBuild(specDir);

    const subtask = readPlan(specDir).phases[0].subtasks[0];
    expect(subtask.title).toBe('Record the baseline'); // added by normalization
    expect(readdirSync(specDir).filter((f) => f.includes('.tmp.'))).toEqual([]);
  });

  it('lets the lightweight LLM repair write its fixed plan too', async () => {
    const planPath = join(specDir, 'implementation_plan.json');
    writeFileSync(planPath, JSON.stringify({ feature: 'f', phases: 'not a list' }));
    const model = new MockLanguageModelV3({
      doGenerate: {
        content: [{ type: 'text', text: JSON.stringify(REPAIRED_PLAN) }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      },
    });

    const result = await repairJsonWithLLM(planPath, ImplementationPlanSchema, ImplementationPlanOutputSchema, model, ['phases: expected array']);

    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(readPlan(specDir).phases[0].subtasks[0].title).toBe('Record the baseline');
  });
});

describe('a valid plan on the real filesystem, spec dir outside os.tmpdir()', () => {
  let specDir: string;
  beforeEach(() => {
    const base = join(resolve(__dirname), '.real-fs-spec');
    mkdirSync(base, { recursive: true });
    specDir = mkdtempSync(join(base, 'spec-'));
  });
  afterEach(() => rmSync(dirname(specDir), { recursive: true, force: true }));

  it('starts coding (on a tmpfs /tmp this is the 2026-10-11 failure, unmocked)', async () => {
    const { outcome, agents } = await runBuild(specDir);

    expect(outcome.error).toBe('Build cancelled');
    expect(agents).toEqual(expect.arrayContaining(['planner', 'coder']));
    expect(readPlan(specDir).phases[0].subtasks[0].title).toBe('Record the baseline');
  });
});
