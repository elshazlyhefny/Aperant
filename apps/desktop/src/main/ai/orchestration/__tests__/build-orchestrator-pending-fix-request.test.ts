/**
 * zeenha fork: a human change request (QA_FIX_REQUEST.md) on a completed build
 * must not be skipped when the task resumes through the BuildOrchestrator,
 * e.g. after the QA phase paused for an account.
 */
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionResult } from '../../session/types';
import { BuildOrchestrator, type SessionRunConfig } from '../build-orchestrator';

let specDir: string;
beforeEach(async () => {
  specDir = await mkdtemp(join(tmpdir(), 'pending-fix-'));
  await writeFile(join(specDir, 'implementation_plan.json'), JSON.stringify({
    feature: 'f',
    workflow_type: 'feature',
    phases: [{ id: 'p1', name: 'Phase 1', subtasks: [{ id: 's1', description: 'd', status: 'completed' }] }],
  }));
  await writeFile(join(specDir, 'qa_report.md'), '# QA Review\n\nStatus: PASSED\n');
});
afterEach(() => rm(specDir, { recursive: true, force: true }));

const result = (outcome: SessionResult['outcome']): SessionResult => ({
  outcome, stepsExecuted: 1, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  messages: [], durationMs: 1, toolCallCount: 0,
});

const exists = (name: string) => access(join(specDir, name)).then(() => true, () => false);

function build(opts: { fixerOutcome?: SessionResult['outcome']; reviewerReport?: string } = {}) {
  const agents: string[] = [];
  const fixerSaw: Array<string | null> = [];
  const runSession = vi.fn(async (config: SessionRunConfig) => {
    agents.push(config.agentType);
    if (config.agentType === 'qa_fixer') {
      fixerSaw.push(await readFile(join(specDir, 'QA_FIX_REQUEST.md'), 'utf-8').catch(() => null));
      return result(opts.fixerOutcome ?? 'completed');
    }
    if (config.agentType === 'qa_reviewer') {
      await writeFile(join(specDir, 'qa_report.md'), opts.reviewerReport ?? 'Status: PASSED');
    }
    return result('completed');
  });
  const orchestrator = new BuildOrchestrator({
    specDir, projectDir: specDir, generatePrompt: async () => 'prompt', runSession,
  });
  return { orchestrator, agents, fixerSaw };
}

describe('resuming a completed build with a pending QA fix request', () => {
  it('runs the fixer and a fresh review instead of returning "already complete"', async () => {
    await writeFile(join(specDir, 'QA_FIX_REQUEST.md'), '# QA Fix Request\n\nStatus: REJECTED\n\n## Feedback\n\nmake the button blue\n');
    const { orchestrator, agents, fixerSaw } = build();

    const outcome = await orchestrator.run();

    expect(agents).toEqual(['qa_fixer', 'qa_reviewer']);
    expect(fixerSaw[0]).toContain('make the button blue');
    expect(outcome.success).toBe(true);
    expect(await exists('QA_FIX_REQUEST.md')).toBe(false);
  });

  it('does not loop: once the request is applied, the next resume short-circuits', async () => {
    await writeFile(join(specDir, 'QA_FIX_REQUEST.md'), 'make the button blue');
    await build().orchestrator.run();

    const second = build();
    const outcome = await second.orchestrator.run();
    expect(second.agents).toEqual([]);
    expect(outcome.success).toBe(true);
  });

  it('keeps the request and fails when the fixer does not complete', async () => {
    await writeFile(join(specDir, 'QA_FIX_REQUEST.md'), 'make the button blue');
    const { orchestrator, agents } = build({ fixerOutcome: 'error' });

    const outcome = await orchestrator.run();

    expect(agents).toEqual(['qa_fixer']);
    expect(outcome.success).toBe(false);
    expect(await exists('QA_FIX_REQUEST.md')).toBe(true);
  });

  it('does not read the old PASSED report as the re-review verdict', async () => {
    await writeFile(join(specDir, 'QA_FIX_REQUEST.md'), 'make the button blue');
    const { orchestrator, agents } = build({ reviewerReport: 'Status: FAILED' });

    const outcome = await orchestrator.run();

    expect(outcome.success).toBe(false);
    expect(agents.slice(0, 2)).toEqual(['qa_fixer', 'qa_reviewer']);
  });

  it('still short-circuits a completed build with no fix request', async () => {
    const { orchestrator, agents } = build();
    const outcome = await orchestrator.run();
    expect(agents).toEqual([]);
    expect(outcome.success).toBe(true);
  });
});

describe('QA pass in the orchestrator', () => {
  it('clears a reviewer-written fix request so the next resume does not rerun the fixer', async () => {
    const { orchestrator } = build();
    const runQA = () => (orchestrator as unknown as { runQAPhase(): Promise<{ success: boolean }> }).runQAPhase();
    await writeFile(join(specDir, 'QA_FIX_REQUEST.md'), 'obsolete reviewer issues');
    await rm(join(specDir, 'qa_report.md'));

    expect(await runQA()).toEqual({ success: true });
    expect(await exists('QA_FIX_REQUEST.md')).toBe(false);
  });
});
