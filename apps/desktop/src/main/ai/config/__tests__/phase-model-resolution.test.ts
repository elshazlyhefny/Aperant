/**
 * zeenha fork: a task's per-phase model reaches the session, and only when that
 * cannot put a provider on a model it does not have.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveSessionModelId } from '../phase-config';

let specDir: string;
beforeEach(async () => {
  specDir = await mkdtemp(join(tmpdir(), 'phase-model-'));
});
afterEach(() => rm(specDir, { recursive: true, force: true }));

const metadata = (value: unknown) => writeFile(join(specDir, 'task_metadata.json'), JSON.stringify(value));
const anthropic = { modelId: 'claude-opus-5-5', provider: 'anthropic' };
const phaseModels = { spec: 'opus', planning: 'opus', coding: 'sonnet', qa: 'opus' };

describe('resolveSessionModelId', () => {
  it('runs each phase on the model the task chose', async () => {
    await metadata({ isAutoProfile: true, phaseModels });
    expect(await resolveSessionModelId(anthropic, specDir, 'coding')).toBe('claude-sonnet-5-5');
    expect(await resolveSessionModelId(anthropic, specDir, 'planning')).toBe('claude-opus-5-5');
  });

  it('keeps the worker model with no metadata', async () => {
    expect(await resolveSessionModelId(anthropic, specDir, 'coding')).toBe('claude-opus-5-5');
  });

  it('keeps the worker model for a task with one model for everything', async () => {
    await metadata({ model: 'sonnet', phaseModels });
    expect(await resolveSessionModelId(anthropic, specDir, 'coding')).toBe('claude-opus-5-5');
  });

  it('never moves another provider onto a Claude model', async () => {
    await metadata({ isAutoProfile: true, phaseModels });
    const codex = { modelId: 'gpt-5.3-codex', provider: 'openai' };
    expect(await resolveSessionModelId(codex, specDir, 'coding')).toBe('gpt-5.3-codex');
  });

  it('honours a phase assigned to another provider', async () => {
    await metadata({ isAutoProfile: true, phaseModels, phaseProviders: { coding: 'openai' } });
    expect(await resolveSessionModelId(anthropic, specDir, 'coding')).toBe('claude-opus-5-5');
  });

  it('ignores a phase model that is not a Claude model', async () => {
    await metadata({ isAutoProfile: true, phaseModels: { coding: 'gpt-5.3-codex' } });
    expect(await resolveSessionModelId(anthropic, specDir, 'coding')).toBe('claude-opus-5-5');
  });
});
