/**
 * zeenha fork: tasks created from Ideation (and Roadmap, Insights, Linear,
 * GitHub import) write a placeholder plan with `phases: []`. The build took
 * "the plan file exists" as "already planned", skipped planning, and failed
 * the empty plan's validation within a second (CODING_FAILED).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionResult } from '../../session/types';
import { BuildOrchestrator, hasAnySubtask } from '../build-orchestrator';

let specDir: string;
beforeEach(async () => {
  specDir = await mkdtemp(join(tmpdir(), 'build-stub-'));
});
afterEach(() => rm(specDir, { recursive: true, force: true }));

const failed: SessionResult = {
  outcome: 'error', stepsExecuted: 0, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  messages: [], durationMs: 0, toolCallCount: 0, error: { code: 'x', message: 'planner stopped here', retryable: false },
};

function orchestrator(runSession = vi.fn(async () => failed)) {
  const o = new BuildOrchestrator({ specDir, projectDir: specDir, generatePrompt: async () => 'prompt', runSession });
  return { o, runSession };
}

const plan = (phases: unknown) => writeFile(join(specDir, 'implementation_plan.json'), JSON.stringify({ feature: 'f', status: 'backlog', phases }));

describe('starting a build', () => {
  it('runs the planner when the plan is the placeholder with no phases', async () => {
    await plan([]);
    const { o, runSession } = orchestrator();

    const outcome = await o.run();

    expect(runSession).toHaveBeenCalledTimes(1);
    expect(runSession.mock.calls[0][0].agentType).toBe('planner');
    expect(outcome.error).toBe('planner stopped here');
  });

  it('runs the planner when phases exist but hold no subtasks', async () => {
    await plan([{ name: 'Empty', subtasks: [] }]);
    const { o, runSession } = orchestrator();
    await o.run();
    expect(runSession.mock.calls[0][0].agentType).toBe('planner');
  });

  it('does not re-plan a planned build', async () => {
    await plan([{ id: 'p1', name: 'Build', subtasks: [{ id: 's1', title: 'Do', description: 'Do', status: 'completed' }] }]);
    const { o, runSession } = orchestrator();

    const outcome = await o.run();

    expect(runSession).not.toHaveBeenCalled();
    expect(outcome.success).toBe(true);
  });
});

describe('hasAnySubtask', () => {
  it('needs at least one subtask in some phase', () => {
    expect(hasAnySubtask(null)).toBe(false);
    expect(hasAnySubtask({ phases: [] })).toBe(false);
    expect(hasAnySubtask({ phases: 'x' })).toBe(false);
    expect(hasAnySubtask({ phases: [{ subtasks: [] }, { subtasks: [{ id: 'a' }] }] })).toBe(true);
  });
});
