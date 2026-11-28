import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionResult } from '../../session/types';
import { SpecOrchestrator } from '../spec-orchestrator';

// zeenha fork: launchTask treats complexity_assessment.json as "the spec pipeline
// already ran", so the orchestrator writes it even when the assessment came from
// the heuristic or from structured output.

const PLAN = JSON.stringify({
  feature: 'Demo',
  phases: [{ id: 'p1', name: 'Implement', subtasks: [{ id: 's1', description: 'Do it', status: 'pending' }] }],
});

const done = (extra: Partial<SessionResult> = {}): SessionResult => ({
  outcome: 'completed', stepsExecuted: 1, durationMs: 1, toolCallCount: 1, messages: [],
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  ...extra,
} as SessionResult);

describe('SpecOrchestrator complexity_assessment.json', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aperant-spec-assess-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function orchestrator(taskDescription: string) {
    return new SpecOrchestrator({
      specDir: dir,
      projectDir: dir,
      taskDescription,
      generatePrompt: async () => 'prompt',
      runSession: async (config) => {
        if (config.specPhase === 'complexity_assessment') {
          return done({
            structuredOutput: { complexity: 'simple', confidence: 0.8, reasoning: 'small change' },
          } as Partial<SessionResult>);
        }
        if (config.specPhase === 'quick_spec') {
          await writeFile(join(dir, 'spec.md'), '# Spec');
          await writeFile(join(dir, 'implementation_plan.json'), PLAN);
        }
        return done();
      },
    });
  }

  async function readAssessment() {
    return JSON.parse(await readFile(join(dir, 'complexity_assessment.json'), 'utf-8'));
  }

  it('writes the heuristic assessment', async () => {
    expect((await orchestrator('Fix typo in title').run()).success).toBe(true);
    expect(await readAssessment()).toMatchObject({ complexity: 'simple' });
  });

  it('writes a structured-output assessment', async () => {
    const outcome = await orchestrator('Add an export button to the reports page that downloads a CSV').run();
    expect(outcome.success).toBe(true);
    expect(await readAssessment()).toMatchObject({ complexity: 'simple', reasoning: 'small change' });
  });
});
