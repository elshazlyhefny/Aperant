/**
 * zeenha fork: an LLM approval only stands when the verify gate passes. Both QA
 * paths (the build orchestrator's QA phase and the standalone QA loop) must turn
 * a gate failure into a rejection that the fixer then works on.
 */
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionResult } from '../../session/types';
import { BuildOrchestrator, type SessionRunConfig } from '../build-orchestrator';
import { QALoop, type QASessionRunConfig } from '../qa-loop';
import type { VerifyGateResult } from '../verify-gate';

let specDir: string;
beforeEach(async () => {
  specDir = await mkdtemp(join(tmpdir(), 'qa-verify-gate-'));
});
afterEach(() => rm(specDir, { recursive: true, force: true }));

const completed: SessionResult = {
  outcome: 'completed', stepsExecuted: 1, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  messages: [], durationMs: 1, toolCallCount: 0,
};

const exists = (path: string) => access(path).then(() => true, () => false);
const fixRequest = () => readFile(join(specDir, 'QA_FIX_REQUEST.md'), 'utf-8');

const FAILED: VerifyGateResult = {
  status: 'failed', reason: 'command_failed', command: 'npm run typecheck',
  outputTail: 'error TS2322: Type string is not assignable', base: 'origin/main', baseMerged: true, notes: [],
};
const PASSED: VerifyGateResult = { status: 'passed', base: 'origin/main', baseMerged: true, notes: [] };

function gateSequence(results: VerifyGateResult[]) {
  return vi.fn(async () => results.shift() ?? PASSED);
}

describe('BuildOrchestrator QA phase with the verify gate', () => {
  function build(verifyGate?: () => Promise<VerifyGateResult>) {
    const agents: string[] = [];
    const fixRequestsSeen: string[] = [];
    const runSession = vi.fn(async (config: SessionRunConfig) => {
      agents.push(config.agentType);
      if (config.agentType === 'qa_reviewer') {
        await writeFile(join(specDir, 'qa_report.md'), 'Status: PASSED');
      } else {
        fixRequestsSeen.push(await fixRequest());
      }
      return completed;
    });
    const logs: string[] = [];
    const orchestrator = new BuildOrchestrator({
      specDir, projectDir: specDir, generatePrompt: async () => 'prompt', runSession, verifyGate,
    });
    orchestrator.on('log', (m: string) => logs.push(m));
    const runQA = () => (orchestrator as unknown as { runQAPhase(): Promise<{ success: boolean; error?: string }> }).runQAPhase();
    return { runQA, agents, fixRequestsSeen, logs };
  }

  it('sends a gate failure to the fixer even though the reviewer approved', async () => {
    const verifyGate = gateSequence([FAILED, PASSED]);
    const { runQA, agents, fixRequestsSeen, logs } = build(verifyGate);

    expect(await runQA()).toEqual({ success: true });
    expect(agents).toEqual(['qa_reviewer', 'qa_fixer', 'qa_reviewer']);
    expect(verifyGate).toHaveBeenCalledTimes(2);
    expect(fixRequestsSeen[0]).toContain('npm run typecheck');
    expect(fixRequestsSeen[0]).toContain('error TS2322');
    expect(logs.some((l) => l.startsWith('Verify gate failed'))).toBe(true);
    expect(await exists(join(specDir, 'QA_FIX_REQUEST.md'))).toBe(false);
  });

  it('fails the build, leaving no approving report, when the gate keeps failing', async () => {
    const { runQA, agents } = build(gateSequence([FAILED, FAILED, FAILED]));

    expect(await runQA()).toEqual({ success: false, error: 'QA review failed after maximum fix cycles' });
    expect(agents).toEqual(['qa_reviewer', 'qa_fixer', 'qa_reviewer', 'qa_fixer', 'qa_reviewer']);
    const report = await readFile(join(specDir, 'qa_report.md'), 'utf-8');
    expect(report.toLowerCase()).not.toContain('status: passed');
    expect(report).toContain('Status: REJECTED');
  });

  it('behaves as before without a gate or with a skipped one', async () => {
    expect(await build().runQA()).toEqual({ success: true });
    const skipped = build(async () => ({ status: 'skipped' }));
    expect(await skipped.runQA()).toEqual({ success: true });
    expect(skipped.agents).toEqual(['qa_reviewer']);
  });
});

describe('QALoop with the verify gate', () => {
  const planPath = () => join(specDir, 'implementation_plan.json');

  async function writePlan(): Promise<void> {
    await writeFile(planPath(), JSON.stringify({
      phases: [{ name: 'Build', subtasks: [{ id: 's1', description: 'Do it', status: 'completed' }] }],
    }, null, 2));
  }

  async function approve(): Promise<void> {
    const plan = JSON.parse(await readFile(planPath(), 'utf-8'));
    plan.qa_signoff = { status: 'approved', timestamp: new Date().toISOString(), qa_session: 1, issues_found: [] };
    await writeFile(planPath(), JSON.stringify(plan, null, 2));
  }

  async function runLoop(verifyGate: (() => Promise<VerifyGateResult>) | undefined, maxIterations = 5) {
    const agents: string[] = [];
    const fixRequestsSeen: string[] = [];
    const loop = new QALoop({
      specDir,
      projectDir: specDir,
      maxIterations,
      verifyGate,
      generatePrompt: async () => 'prompt',
      runSession: async (cfg: QASessionRunConfig) => {
        agents.push(cfg.agentType);
        if (cfg.agentType === 'qa_reviewer') await approve();
        else fixRequestsSeen.push(await fixRequest());
        return completed;
      },
    });
    const outcome = await loop.run();
    return { outcome, agents, fixRequestsSeen };
  }

  beforeEach(writePlan);

  it('flips an approval to a rejection, runs the fixer, then approves once the gate passes', async () => {
    const verifyGate = gateSequence([FAILED, PASSED]);
    const { outcome, agents, fixRequestsSeen } = await runLoop(verifyGate);

    expect(outcome.approved).toBe(true);
    expect(agents).toEqual(['qa_reviewer', 'qa_fixer', 'qa_reviewer']);
    expect(fixRequestsSeen[0]).toContain('npm run typecheck');
    const plan = JSON.parse(await readFile(planPath(), 'utf-8'));
    expect(plan.qa_iteration_history.map((r: { status: string }) => r.status)).toEqual(['rejected', 'approved']);
    expect(plan.qa_iteration_history[0].issues[0].title).toBe('Verify gate: npm run typecheck failed');
    // Approval clears the gate's request, like a reviewer's
    expect(await exists(join(specDir, 'QA_FIX_REQUEST.md'))).toBe(false);
  });

  it('does not leave an approved signoff behind when it stops on a gate failure', async () => {
    const { outcome } = await runLoop(gateSequence([FAILED]), 1);

    expect(outcome.approved).toBe(false);
    const plan = JSON.parse(await readFile(planPath(), 'utf-8'));
    expect(plan.qa_signoff.status).toBe('rejected');
    expect(await exists(join(specDir, 'QA_FIX_REQUEST.md'))).toBe(true);
  });

  it('approves at once without a gate or with a skipped one', async () => {
    expect((await runLoop(undefined)).agents).toEqual(['qa_reviewer']);
    await writePlan();
    const skipped = await runLoop(async () => ({ status: 'skipped' }));
    expect(skipped.outcome.approved).toBe(true);
    expect(skipped.agents).toEqual(['qa_reviewer']);
  });
});
