import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionResult } from '../../session/types';
import { SpecOrchestrator, type SpecPhase, type SpecSessionRunConfig } from '../spec-orchestrator';

const OUTPUTS: Partial<Record<SpecPhase, Record<string, string>>> = {
  discovery: { 'context.json': '{"files_to_modify":["src/title.ts"]}' },
  requirements: { 'requirements.json': '{"task_description":"Fix typo"}' },
  spec_writing: { 'spec.md': '# Specification' },
  quick_spec: { 'spec.md': '# Quick Spec' },
};

const PLAN = JSON.stringify({
  feature: 'Demo',
  phases: [{ id: 'p1', name: 'Implement', subtasks: [{ id: 's1', description: 'Fix typo', status: 'pending' }] }],
});

describe('SpecOrchestrator simple tier', () => {
  let dir: string;
  let sessions: SpecSessionRunConfig[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aperant-spec-orch-'));
    sessions = [];
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function orchestrator(separatePlanning: boolean) {
    return new SpecOrchestrator({
      specDir: dir,
      projectDir: dir,
      taskDescription: 'Fix typo in title',
      complexityOverride: 'simple',
      separatePlanning,
      generatePrompt: async () => 'prompt',
      runSession: async (config): Promise<SessionResult> => {
        sessions.push(config);
        for (const [name, content] of Object.entries(OUTPUTS[config.specPhase] ?? {})) {
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

  it('keeps quick_spec when planning shares the spec connection', async () => {
    const outcome = await orchestrator(false).run();
    expect(outcome.success).toBe(true);
    expect(sessions.map(s => s.specPhase)).toEqual(['quick_spec', 'validation']);
  });

  it('gives spec_writer project context when planning runs separately', async () => {
    const outcome = await orchestrator(true).run();
    expect(outcome.success).toBe(true);
    expect(sessions.map(s => s.specPhase)).toEqual(['discovery', 'requirements', 'spec_writing', 'planning', 'validation']);
    const specWriting = sessions.find(s => s.specPhase === 'spec_writing');
    expect(specWriting?.priorPhaseOutputs).toMatchObject({
      'context.json': expect.stringContaining('src/title.ts'),
      'requirements.json': expect.stringContaining('Fix typo'),
    });
    expect(sessions.find(s => s.specPhase === 'planning')?.phase).toBe('planning');
  });
});
