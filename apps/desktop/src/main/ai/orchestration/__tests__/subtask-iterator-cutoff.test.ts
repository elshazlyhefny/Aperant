/**
 * zeenha fork: a coder session stopped by its step limit or context window was
 * cut off mid-work. It used to be force-marked "completed", so a half-done
 * subtask passed straight on to QA.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SessionResult } from '../../session/types';
import { iterateSubtasks } from '../subtask-iterator';

let specDir: string;
beforeEach(async () => {
  specDir = await mkdtemp(join(tmpdir(), 'subtask-cutoff-'));
  await writeFile(
    join(specDir, 'implementation_plan.json'),
    JSON.stringify({ phases: [{ name: 'Build', subtasks: [{ id: 's1', title: 'Do it', description: 'Do it', status: 'pending' }] }] }),
  );
});
afterEach(() => rm(specDir, { recursive: true, force: true }));

const session = (outcome: SessionResult['outcome']): SessionResult => ({
  outcome, stepsExecuted: 1, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, messages: [], durationMs: 0, toolCallCount: 0,
});

async function status(): Promise<string> {
  const plan = JSON.parse(await readFile(join(specDir, 'implementation_plan.json'), 'utf-8'));
  return plan.phases[0].subtasks[0].status;
}

function run(outcome: SessionResult['outcome'], onSession?: () => Promise<void>) {
  let sessions = 0;
  return {
    sessions: () => sessions,
    result: iterateSubtasks({
      specDir,
      projectDir: specDir,
      maxRetries: 2,
      autoContinueDelayMs: 0,
      runSubtaskSession: async () => {
        sessions++;
        await onSession?.();
        return session(outcome);
      },
    }),
  };
}

describe('a coder session that was cut off', () => {
  it.each(['max_steps', 'context_window'] as const)('is not marked completed after %s; it is retried, then stuck', async (outcome) => {
    const r = run(outcome);
    const result = await r.result;
    expect(await status()).not.toBe('completed');
    expect(r.sessions()).toBe(2);
    expect(result.stuckSubtasks).toEqual(['s1']);
  });

  it('counts when the coder marked the subtask completed itself before being cut off', async () => {
    const r = run('max_steps', async () => {
      const path = join(specDir, 'implementation_plan.json');
      const plan = JSON.parse(await readFile(path, 'utf-8'));
      plan.phases[0].subtasks[0].status = 'completed';
      await writeFile(path, JSON.stringify(plan));
    });
    const result = await r.result;
    expect(r.sessions()).toBe(1);
    expect(result.stuckSubtasks).toEqual([]);
  });

  it('a completed session still marks the subtask completed', async () => {
    const r = run('completed');
    await r.result;
    expect(await status()).toBe('completed');
    expect(r.sessions()).toBe(1);
  });
});
