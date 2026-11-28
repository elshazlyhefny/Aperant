import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionResult } from '../../session/types';
import {
  type ComplexityTier,
  SpecOrchestrator,
  type SpecPhase,
  type SpecSessionRunConfig,
} from '../spec-orchestrator';

const STUB = '# Add dark mode\n\nStub spec written by Ideation.\n';

const PLAN = JSON.stringify({
  feature: 'Demo',
  phases: [{ id: 'p1', name: 'Implement', subtasks: [{ id: 's1', description: 'Do it', status: 'pending' }] }],
});

// zeenha fork: Ideation/Roadmap tasks start with a stub spec.md, so a spec-writing
// phase that writes nothing must not pass on spec.md merely existing.
describe('SpecOrchestrator with a pre-existing stub spec.md', () => {
  let dir: string;
  let sessions: SpecSessionRunConfig[];
  let retryContexts: Array<string | undefined>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aperant-spec-stub-'));
    sessions = [];
    retryContexts = [];
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** `outputs` maps a phase to the files its session writes; `onSession` runs before them. */
  function orchestrator(
    complexity: ComplexityTier,
    outputs: Partial<Record<SpecPhase, Record<string, string>>>,
    onSession?: (config: SpecSessionRunConfig) => Promise<void>,
  ) {
    return new SpecOrchestrator({
      specDir: dir,
      projectDir: dir,
      taskDescription: 'Add a dark mode toggle to the settings page',
      complexityOverride: complexity,
      generatePrompt: async (_agent, phase, context) => {
        if (phase === 'quick_spec' || phase === 'spec_writing') retryContexts.push(context.schemaRetryContext);
        return 'prompt';
      },
      runSession: async (config): Promise<SessionResult> => {
        sessions.push(config);
        await onSession?.(config);
        for (const [name, content] of Object.entries(outputs[config.specPhase] ?? {})) {
          await writeFile(join(dir, name), content);
        }
        if (config.specPhase === 'planning' || config.specPhase === 'quick_spec') {
          await writeFile(join(dir, 'implementation_plan.json'), PLAN);
        }
        return {
          outcome: 'completed', stepsExecuted: 1, durationMs: 1, toolCallCount: 1, messages: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        } as SessionResult;
      },
    });
  }

  it('retries and then fails a quick_spec session that leaves the stub untouched', async () => {
    await writeFile(join(dir, 'spec.md'), STUB);

    const outcome = await orchestrator('simple', {}).run();

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain('unchanged from the pre-existing stub');
    expect(sessions.map(s => s.specPhase)).toEqual(['quick_spec', 'quick_spec', 'quick_spec']);
    expect(retryContexts[0]).toBeUndefined();
    expect(retryContexts[1]).toContain('SPEC NOT WRITTEN');
    expect(await readFile(join(dir, 'spec.md'), 'utf-8')).toBe(STUB);
  });

  it('fails a spec_writing session that leaves the stub untouched', async () => {
    await writeFile(join(dir, 'spec.md'), STUB);

    const outcome = await orchestrator('standard', {
      discovery: { 'context.json': '{}' },
      requirements: { 'requirements.json': '{}' },
    }).run();

    expect(outcome.success).toBe(false);
    expect(sessions.map(s => s.specPhase)).toEqual([
      'discovery', 'requirements', 'spec_writing', 'spec_writing', 'spec_writing',
    ]);
  });

  it('passes once a retry rewrites the stub', async () => {
    await writeFile(join(dir, 'spec.md'), STUB);
    let quickSpecRuns = 0;

    const outcome = await orchestrator('simple', {}, async (config) => {
      if (config.specPhase === 'quick_spec' && ++quickSpecRuns === 2) {
        await writeFile(join(dir, 'spec.md'), '# Full specification');
      }
    }).run();

    expect(outcome.success).toBe(true);
    expect(sessions.map(s => s.specPhase)).toEqual(['quick_spec', 'quick_spec', 'validation']);
  });

  it('passes when the writer rewrites the stub', async () => {
    await writeFile(join(dir, 'spec.md'), STUB);

    const outcome = await orchestrator('simple', { quick_spec: { 'spec.md': '# Full specification' } }).run();

    expect(outcome.success).toBe(true);
    expect(sessions.map(s => s.specPhase)).toEqual(['quick_spec', 'validation']);
  });

  it('does not judge later phases against a stub an earlier phase already rewrote', async () => {
    await writeFile(join(dir, 'spec.md'), STUB);

    const outcome = await orchestrator('standard', {
      discovery: { 'context.json': '{}', 'spec.md': '# Rewritten during discovery' },
      requirements: { 'requirements.json': '{}' },
    }).run();

    expect(outcome.success).toBe(true);
    expect(sessions.map(s => s.specPhase)).toEqual([
      'discovery', 'requirements', 'spec_writing', 'planning', 'validation',
    ]);
  });

  it('keeps the existence check when there was no pre-existing spec.md', async () => {
    const passing = await orchestrator('simple', { quick_spec: { 'spec.md': '# Spec' } }).run();
    expect(passing.success).toBe(true);
    expect(sessions.map(s => s.specPhase)).toEqual(['quick_spec', 'validation']);

    await rm(join(dir, 'spec.md'));
    sessions = [];
    const failing = await orchestrator('simple', {}).run();
    expect(failing.success).toBe(false);
    expect(failing.error).toContain('expected output files missing: spec.md');
    expect(sessions.map(s => s.specPhase)).toEqual(['quick_spec', 'quick_spec', 'quick_spec']);
  });
});
