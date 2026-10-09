/**
 * zeenha fork: the QA loop read whatever qa_signoff was in implementation_plan.json
 * after a reviewer session, so a stale "approved" from an earlier run could pass a
 * user's change request whose fixer and reviewer both failed. And the reviewer's own
 * QA_FIX_REQUEST.md, left behind after a later approval, was read as human feedback
 * by the next run. These tests drive the loop against a real spec dir.
 */
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SessionResult } from '../../session/types';
import { QALoop, type QASessionRunConfig } from '../qa-loop';

let specDir: string;
const planPath = () => join(specDir, 'implementation_plan.json');
const fixRequestPath = () => join(specDir, 'QA_FIX_REQUEST.md');

async function writePlan(qaSignoff?: Record<string, unknown>): Promise<void> {
  const plan: Record<string, unknown> = {
    phases: [{ name: 'Build', subtasks: [{ id: 's1', description: 'Do it', status: 'completed' }] }],
  };
  if (qaSignoff) plan.qa_signoff = qaSignoff;
  await writeFile(planPath(), JSON.stringify(plan, null, 2));
}

/** What a reviewer session does: rewrite qa_signoff in the plan, keeping the rest. */
async function writeSignoff(qaSignoff: Record<string, unknown>): Promise<void> {
  const plan = JSON.parse(await readFile(planPath(), 'utf-8'));
  plan.qa_signoff = qaSignoff;
  await writeFile(planPath(), JSON.stringify(plan, null, 2));
}

const exists = (path: string) => access(path).then(() => true, () => false);

const session = (outcome: SessionResult['outcome']): SessionResult => ({
  outcome,
  stepsExecuted: 1,
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  messages: [],
  durationMs: 0,
  toolCallCount: 0,
  error: outcome === 'error' ? { code: 'error', message: 'boom', retryable: false } : undefined,
});

type Step = (cfg: QASessionRunConfig) => Promise<SessionResult['outcome']>;

/** Run the loop with a scripted sequence of sessions; returns the outcome and the agent types run. */
async function runLoop(steps: Step[], maxIterations = 5) {
  const agents: string[] = [];
  const loop = new QALoop({
    specDir,
    projectDir: specDir,
    maxIterations,
    generatePrompt: async () => 'prompt',
    runSession: async (cfg) => {
      agents.push(cfg.agentType);
      const step = steps[agents.length - 1];
      if (!step) throw new Error(`unexpected session #${agents.length} (${cfg.agentType})`);
      return session(await step(cfg));
    },
  });
  const outcome = await loop.run();
  return { outcome, agents };
}

const STALE_APPROVAL = { status: 'approved', timestamp: '2026-01-01T00:00:00Z', qa_session: 1, issues_found: [] };

beforeEach(async () => {
  specDir = await mkdtemp(join(tmpdir(), 'qa-loop-fresh-'));
});
afterEach(() => rm(specDir, { recursive: true, force: true }));

describe('a stale qa_signoff', () => {
  it('is not approval when the change-request fixer completes and the reviewer fails', async () => {
    await writePlan(STALE_APPROVAL);
    await writeFile(fixRequestPath(), '# QA Fix Request\n\nStatus: REJECTED\n\n## Feedback\n\nMake the button blue\n');

    const { outcome, agents } = await runLoop([
      async () => 'completed', // human-feedback fixer
      async () => 'error', // reviewer fails, writes nothing
    ]);

    expect(agents).toEqual(['qa_fixer', 'qa_reviewer']);
    expect(outcome.approved).toBe(false);
    expect(outcome.reason).toBe('error');
  });

  it('is not approval when the reviewer "completes" without writing a verdict', async () => {
    await writePlan(STALE_APPROVAL);
    await writeFile(fixRequestPath(), 'Make the button blue');

    const { outcome, agents } = await runLoop([
      async () => 'completed', // fixer
      async () => 'completed', // reviewers that never touch qa_signoff
      async () => 'completed',
      async () => 'completed',
    ]);

    expect(agents).toEqual(['qa_fixer', 'qa_reviewer', 'qa_reviewer', 'qa_reviewer']);
    expect(outcome.approved).toBe(false);
    expect(outcome.reason).toBe('consecutive_errors');
  });

  it('stops with an error, keeping the change request, when the change-request fixer fails', async () => {
    await writePlan(STALE_APPROVAL);
    await writeFile(fixRequestPath(), 'Make the button blue');

    const { outcome, agents } = await runLoop([async () => 'error']);

    expect(agents).toEqual(['qa_fixer']);
    expect(outcome.approved).toBe(false);
    expect(outcome.reason).toBe('error');
    // Kept, so the next run retries the user's request instead of short-circuiting on the stale approval
    expect(await exists(fixRequestPath())).toBe(true);
  });
});

describe('a verdict the reviewer writes', () => {
  it('approves when the reviewer writes "approved" during the session', async () => {
    await writePlan();

    const { outcome, agents } = await runLoop([
      async () => {
        await writeSignoff({ status: 'approved', timestamp: '2026-10-09T10:00:00Z', qa_session: 1, issues_found: [] });
        return 'completed';
      },
    ]);

    expect(agents).toEqual(['qa_reviewer']);
    expect(outcome.approved).toBe(true);
  });

  it('approves a stale-approved change request once the reviewer writes a new approval', async () => {
    await writePlan(STALE_APPROVAL);
    await writeFile(fixRequestPath(), 'Make the button blue');

    const { outcome } = await runLoop([
      async () => 'completed', // fixer
      async () => {
        await writeSignoff({ status: 'approved', timestamp: '2026-10-09T10:00:00Z', qa_session: 2, issues_found: [] });
        return 'completed';
      },
    ]);

    expect(outcome.approved).toBe(true);
  });

  it('reports an error when the reviewer errors without writing a signoff', async () => {
    await writePlan();

    const { outcome, agents } = await runLoop([async () => 'error']);

    expect(agents).toEqual(['qa_reviewer']);
    expect(outcome.approved).toBe(false);
    expect(outcome.reason).toBe('error');
    expect(outcome.error).toContain('error');
  });

  it('retries, rather than failing outright, a reviewer cut off by max_steps', async () => {
    await writePlan();

    const { outcome, agents } = await runLoop([
      async () => 'max_steps',
      async () => {
        await writeSignoff({ status: 'approved', timestamp: '2026-10-09T10:00:00Z', qa_session: 2, issues_found: [] });
        return 'completed';
      },
    ]);

    expect(agents).toEqual(['qa_reviewer', 'qa_reviewer']);
    expect(outcome.approved).toBe(true);
  });
});

describe("the reviewer's own QA_FIX_REQUEST.md", () => {
  it('is removed on approval, so the next run short-circuits instead of running a fixer', async () => {
    await writePlan();

    const first = await runLoop([
      async () => {
        // Reviewer rejects and, as prompts/qa_reviewer.md tells it to, writes a fix request
        await writeFile(fixRequestPath(), '# QA Fix Request\n\n**Status**: REJECTED\n\n### 1. Null check missing\n');
        await writeSignoff({
          status: 'rejected',
          timestamp: '2026-10-09T10:00:00Z',
          qa_session: 1,
          issues_found: [{ type: 'critical', title: 'Null check missing' }],
          fix_request_file: 'QA_FIX_REQUEST.md',
        });
        return 'completed';
      },
      async () => 'completed', // fixer
      async () => {
        await writeSignoff({ status: 'approved', timestamp: '2026-10-09T10:05:00Z', qa_session: 3, issues_found: [] });
        return 'completed';
      },
    ]);

    expect(first.agents).toEqual(['qa_reviewer', 'qa_fixer', 'qa_reviewer']);
    expect(first.outcome.approved).toBe(true);
    expect(await exists(fixRequestPath())).toBe(false);

    const second = await runLoop([]);
    expect(second.agents).toEqual([]);
    expect(second.outcome.approved).toBe(true);
    expect(second.outcome.totalIterations).toBe(0);
  });
});
