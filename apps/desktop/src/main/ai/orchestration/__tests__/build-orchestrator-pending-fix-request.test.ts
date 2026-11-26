/**
 * zeenha fork: a human change request (QA_FIX_REQUEST.md) on a completed build
 * must not be skipped when the task resumes through the BuildOrchestrator,
 * e.g. after the QA phase paused for an account.
 */
import { access, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionResult } from '../../session/types';
import { buildFollowUpRequest } from '../../../ipc-handlers/task/pr-followup-request';
import { BuildOrchestrator, FIX_AWAITING_REVIEW_MARKER, isHumanFixRequest, type SessionRunConfig } from '../build-orchestrator';

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

/** The text "Request changes" in task review writes (ipc-handlers/task/execution-handlers.ts). */
const humanRequest = (feedback: string) =>
  `# QA Fix Request\n\nStatus: REJECTED\n\n## Feedback\n\n${feedback}\n\nCreated at: 2026-11-26T00:00:00.000Z\n`;

/** The text a rejecting reviewer writes (prompts/qa_reviewer.md). */
const REVIEWER_REQUEST =
  '# QA Fix Request\n\n**Status**: REJECTED\n**Date**: 2026-11-01\n**QA Session**: 1\n\n## Critical Issues to Fix\n\n### 1. Old issue\n';

/** Make `older` predate `newer` by a minute, whatever the filesystem timestamp granularity. */
async function age(older: string, newer: string): Promise<void> {
  const now = Date.now() / 1000;
  await utimes(join(specDir, older), now - 60, now - 60);
  await utimes(join(specDir, newer), now, now);
}

function build(opts: {
  fixerOutcome?: SessionResult['outcome'];
  reviewerReport?: string;
  reviewer?: () => Promise<SessionResult>;
  requireQAVerdict?: boolean;
} = {}) {
  const agents: string[] = [];
  const fixerSaw: Array<string | null> = [];
  const runSession = vi.fn(async (config: SessionRunConfig) => {
    agents.push(config.agentType);
    if (config.agentType === 'qa_fixer') {
      fixerSaw.push(await readFile(join(specDir, 'QA_FIX_REQUEST.md'), 'utf-8').catch(() => null));
      return result(opts.fixerOutcome ?? 'completed');
    }
    if (config.agentType === 'qa_reviewer') {
      if (opts.reviewer) return opts.reviewer();
      await writeFile(join(specDir, 'qa_report.md'), opts.reviewerReport ?? 'Status: PASSED');
    }
    return result('completed');
  });
  const orchestrator = new BuildOrchestrator({
    specDir, projectDir: specDir, generatePrompt: async () => 'prompt', runSession,
    requireQAVerdict: opts.requireQAVerdict,
  });
  return { orchestrator, agents, fixerSaw };
}

describe('resuming a completed build with a pending QA fix request', () => {
  it('runs the fixer and a fresh review instead of returning "already complete"', async () => {
    await writeFile(join(specDir, 'QA_FIX_REQUEST.md'), humanRequest('make the button blue'));
    const { orchestrator, agents, fixerSaw } = build();

    const outcome = await orchestrator.run();

    expect(agents).toEqual(['qa_fixer', 'qa_reviewer']);
    expect(fixerSaw[0]).toContain('make the button blue');
    expect(outcome.success).toBe(true);
    expect(await exists('QA_FIX_REQUEST.md')).toBe(false);
    expect(await exists(FIX_AWAITING_REVIEW_MARKER)).toBe(false);
  });

  it('honours a human request even when the fixer touched qa_report.md after it', async () => {
    await writeFile(join(specDir, 'QA_FIX_REQUEST.md'), humanRequest('make the button blue'));
    await age('QA_FIX_REQUEST.md', 'qa_report.md');
    const { orchestrator, agents } = build();

    await orchestrator.run();

    expect(agents).toEqual(['qa_fixer', 'qa_reviewer']);
  });

  it('honours a PR follow-up request', async () => {
    const text = buildFollowUpRequest(
      [{ id: 'c1', kind: 'review_thread', title: 'Rename x', summary: 'please rename x', truncated: false }],
      { prUrl: 'https://github.com/o/r/pull/1', prNumber: 1, branch: 'b' },
    );
    expect(isHumanFixRequest(text)).toBe(true);
    await writeFile(join(specDir, 'QA_FIX_REQUEST.md'), text);
    await age('QA_FIX_REQUEST.md', 'qa_report.md');
    const { orchestrator, agents } = build();

    await orchestrator.run();

    expect(agents).toEqual(['qa_fixer', 'qa_reviewer']);
  });

  it('short-circuits an already-passed task that still has a stale reviewer request', async () => {
    // Before PR #176 a passing review left the rejecting reviewer's request behind.
    await writeFile(join(specDir, 'QA_FIX_REQUEST.md'), REVIEWER_REQUEST);
    await age('QA_FIX_REQUEST.md', 'qa_report.md');
    expect(isHumanFixRequest(REVIEWER_REQUEST)).toBe(false);
    const { orchestrator, agents } = build();

    const outcome = await orchestrator.run();

    expect(agents).toEqual([]);
    expect(outcome.success).toBe(true);
  });

  it('treats an unmarked request with no QA report after it as pending', async () => {
    await writeFile(join(specDir, 'QA_FIX_REQUEST.md'), REVIEWER_REQUEST);
    await age('qa_report.md', 'QA_FIX_REQUEST.md');
    const { orchestrator, agents } = build();

    await orchestrator.run();

    expect(agents).toEqual(['qa_fixer', 'qa_reviewer']);
  });

  it('counts a max_steps or context_window fixer outcome as done', async () => {
    for (const fixerOutcome of ['max_steps', 'context_window'] as const) {
      await writeFile(join(specDir, 'QA_FIX_REQUEST.md'), humanRequest('make the button blue'));
      const { orchestrator, agents } = build({ fixerOutcome });

      const outcome = await orchestrator.run();

      expect(agents).toEqual(['qa_fixer', 'qa_reviewer']);
      expect(outcome.success).toBe(true);
      expect(await exists('QA_FIX_REQUEST.md')).toBe(false);
    }
  });

  it('does not loop: once the request is applied, the next resume short-circuits', async () => {
    await writeFile(join(specDir, 'QA_FIX_REQUEST.md'), humanRequest('make the button blue'));
    await build().orchestrator.run();

    const second = build();
    const outcome = await second.orchestrator.run();
    expect(second.agents).toEqual([]);
    expect(outcome.success).toBe(true);
  });

  it('keeps the request and fails when the fixer errors', async () => {
    await writeFile(join(specDir, 'QA_FIX_REQUEST.md'), humanRequest('make the button blue'));
    const { orchestrator, agents } = build({ fixerOutcome: 'error' });

    const outcome = await orchestrator.run();

    expect(agents).toEqual(['qa_fixer']);
    expect(outcome.success).toBe(false);
    expect(await exists('QA_FIX_REQUEST.md')).toBe(true);
  });

  it('does not read the old PASSED report as the re-review verdict', async () => {
    await writeFile(join(specDir, 'QA_FIX_REQUEST.md'), humanRequest('make the button blue'));
    const { orchestrator, agents } = build({ reviewerReport: 'Status: FAILED' });

    const outcome = await orchestrator.run();

    expect(outcome.success).toBe(false);
    expect(agents.slice(0, 2)).toEqual(['qa_fixer', 'qa_reviewer']);
  });

  it('resumes an interrupted re-review on an unrouted task instead of returning "already complete"', async () => {
    await writeFile(join(specDir, 'QA_FIX_REQUEST.md'), humanRequest('make the button blue'));
    // The re-review is stopped before it writes a verdict.
    const first = build({ reviewer: async () => result('cancelled') });
    expect((await first.orchestrator.run()).success).toBe(false);
    expect(first.agents).toEqual(['qa_fixer', 'qa_reviewer']);
    expect(await exists('QA_FIX_REQUEST.md')).toBe(false);
    expect(await exists(FIX_AWAITING_REVIEW_MARKER)).toBe(true);

    const second = build({ requireQAVerdict: false });
    const outcome = await second.orchestrator.run();

    expect(second.agents).toEqual(['qa_reviewer']);
    expect(outcome.success).toBe(true);
    expect(await exists(FIX_AWAITING_REVIEW_MARKER)).toBe(false);

    // Reviewed: the next resume short-circuits again.
    const third = build();
    expect((await third.orchestrator.run()).success).toBe(true);
    expect(third.agents).toEqual([]);
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
