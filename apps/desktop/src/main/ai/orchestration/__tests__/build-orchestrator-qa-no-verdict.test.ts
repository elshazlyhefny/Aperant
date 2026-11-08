/**
 * zeenha fork: a QA review with no verdict judged nothing, so it must not spend
 * a fix cycle or be reported as a code failure.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionResult } from '../../session/types';
import { BuildOrchestrator, QA_NO_VERDICT_MESSAGE, type SessionRunConfig } from '../build-orchestrator';

let specDir: string;
beforeEach(async () => {
  specDir = await mkdtemp(join(tmpdir(), 'qa-verdict-'));
});
afterEach(() => rm(specDir, { recursive: true, force: true }));

const completed: SessionResult = {
  outcome: 'completed', stepsExecuted: 1, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  messages: [], durationMs: 1, toolCallCount: 0,
};

/** Each review writes the next report in the list; null writes none. */
function build(reports: Array<string | null>, abort?: AbortController) {
  const agents: string[] = [];
  const waitBeforeQARetry = vi.fn(async () => {
    abort?.abort();
  });
  const runSession = vi.fn(async (config: SessionRunConfig) => {
    agents.push(config.agentType);
    if (config.agentType === 'qa_reviewer') {
      const report = reports.shift() ?? null;
      if (report !== null) await writeFile(join(specDir, 'qa_report.md'), report);
    }
    return completed;
  });
  const orchestrator = new BuildOrchestrator({
    specDir, projectDir: specDir, generatePrompt: async () => 'prompt', runSession, waitBeforeQARetry,
    abortSignal: abort?.signal,
  });
  const runQA = () => (orchestrator as unknown as { runQAPhase(): Promise<{ success: boolean; error?: string }> }).runQAPhase();
  return { runQA, agents, waitBeforeQARetry };
}

describe('QA review with no verdict', () => {
  it('retries the review once, after waiting, without running the fixer', async () => {
    const { runQA, agents, waitBeforeQARetry } = build([null, 'Status: PASSED']);
    expect(await runQA()).toEqual({ success: true });
    expect(agents).toEqual(['qa_reviewer', 'qa_reviewer']);
    expect(waitBeforeQARetry).toHaveBeenCalledTimes(1);
  });

  it('says plainly that nothing was judged when it happens twice', async () => {
    const { runQA, agents } = build([null, null]);
    expect(await runQA()).toEqual({ success: false, error: QA_NO_VERDICT_MESSAGE });
    expect(agents).toEqual(['qa_reviewer', 'qa_reviewer']);
  });

  it('does not spend a fix cycle: three real rejections still get their fixes', async () => {
    const { runQA, agents } = build([null, 'Status: FAILED', 'Status: FAILED', 'Status: FAILED']);
    await runQA();
    expect(agents).toEqual(['qa_reviewer', 'qa_reviewer', 'qa_fixer', 'qa_reviewer', 'qa_fixer', 'qa_reviewer']);
  });

  it('a report with no recognizable status also counts as no verdict', async () => {
    const { runQA, agents } = build(['Environment: suite killed', 'Status: APPROVED']);
    expect(await runQA()).toEqual({ success: true });
    expect(agents).toEqual(['qa_reviewer', 'qa_reviewer']);
  });

  it('stops if the build is cancelled during the wait', async () => {
    const { runQA, agents } = build([null, 'Status: PASSED'], new AbortController());
    expect(await runQA()).toEqual({ success: false, error: 'Build cancelled' });
    expect(agents).toEqual(['qa_reviewer']);
  });
});

describe('QA review that rejects the code', () => {
  it('still goes to the fixer', async () => {
    const { runQA, agents, waitBeforeQARetry } = build(['Status: FAILED', 'Status: PASSED']);
    expect(await runQA()).toEqual({ success: true });
    expect(agents).toEqual(['qa_reviewer', 'qa_fixer', 'qa_reviewer']);
    expect(waitBeforeQARetry).not.toHaveBeenCalled();
  });
});
