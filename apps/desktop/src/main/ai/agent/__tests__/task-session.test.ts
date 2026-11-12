import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

vi.mock('../../security/security-profile', () => ({
  getSecurityProfile: () => ({
    baseCommands: new Set(['ls']),
    stackCommands: new Set(['npm']),
    scriptCommands: new Set(['build']),
    customCommands: new Set(['foo']),
    customScripts: { shellScripts: ['run.sh'] },
  }),
}));

import {
  serializeSecurityProfile,
  buildTaskExecutionMessages,
  readTaskMetadata,
  resolveTaskPhaseProvider,
  resolveTaskModelId,
  resolveTaskTokenBudget,
} from '../task-session';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'task-session-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('serializeSecurityProfile', () => {
  it('carries settings and converts Sets to arrays', () => {
    const result = serializeSecurityProfile('/proj', {
      prOnlyLanding: true,
      envPassthrough: ['FOO'],
      bashSandbox: 'auto',
      webFetchProvider: 'direct',
    });
    expect(result.prOnlyLanding).toBe(true);
    expect(result.envPassthrough).toEqual(['FOO']);
    expect(result.bashSandbox).toBe('auto');
    expect(result.webFetchProvider).toBe('direct');
    expect(Array.isArray(result.baseCommands)).toBe(true);
    expect(result.baseCommands).toEqual(['ls']);
    expect(result.stackCommands).toEqual(['npm']);
    expect(result.scriptCommands).toEqual(['build']);
    expect(result.customCommands).toEqual(['foo']);
    expect(result.customScripts.shellScripts).toEqual(['run.sh']);
  });
});

describe('buildTaskExecutionMessages', () => {
  it('asks to create a plan when none exists', () => {
    writeFileSync(path.join(dir, 'spec.md'), '# My spec');
    const [msg] = buildTaskExecutionMessages(dir, '001-x', '/proj');
    expect(msg.role).toBe('user');
    expect(msg.content).toContain('# My spec');
    expect(msg.content).toContain('No implementation plan exists yet');
  });

  it('includes the plan and resume instruction when present', () => {
    writeFileSync(path.join(dir, 'spec.md'), '# My spec');
    writeFileSync(path.join(dir, 'implementation_plan.json'), '{"phases":[]}');
    const [msg] = buildTaskExecutionMessages(dir, '001-x', '/proj');
    expect(msg.content).toContain('{"phases":[]}');
    expect(msg.content).toContain('Resume implementing');
    expect(msg.content).not.toContain('No implementation plan exists yet');
  });
});

describe('task metadata resolution', () => {
  const writeMeta = (m: unknown) =>
    writeFileSync(path.join(dir, 'task_metadata.json'), JSON.stringify(m));

  it('returns null / default when metadata is missing', async () => {
    expect(readTaskMetadata(dir)).toBeNull();
    expect(resolveTaskPhaseProvider(dir, 'coding')).toBeNull();
    const id = await resolveTaskModelId(dir, 'coding', () => undefined);
    expect(id).toContain('sonnet');
  });

  it('prefers per-phase provider over task provider', () => {
    writeMeta({ provider: 'ollama', phaseProviders: { qa: 'openai' } });
    expect(resolveTaskPhaseProvider(dir, 'qa')).toBe('openai');
    expect(resolveTaskPhaseProvider(dir, 'coding')).toBe('ollama');
  });

  it('resolves Anthropic shorthand from phaseModels', async () => {
    writeMeta({ phaseModels: { coding: 'opus' } });
    const id = await resolveTaskModelId(dir, 'coding', () => undefined);
    expect(id).toContain('opus');
  });

  it('uses injected provider phase models when shorthand is empty', async () => {
    writeMeta({ provider: 'ollama', model: '' });
    const reader = vi.fn(() => ({ coding: 'my-local-model' }));
    const id = await resolveTaskModelId(dir, 'coding', reader);
    expect(reader).toHaveBeenCalledWith('ollama');
    expect(id).toContain('my-local-model');
  });
});

describe('resolveTaskTokenBudget', () => {
  it('uses the task override, else the project default', () => {
    expect(resolveTaskTokenBudget(dir)).toBeUndefined();
    expect(resolveTaskTokenBudget(dir, { tokenBudget: 100 })).toBe(100);
    writeFileSync(path.join(dir, 'task_metadata.json'), JSON.stringify({ tokenBudget: 500 }));
    expect(resolveTaskTokenBudget(dir, { tokenBudget: 100 })).toBe(500);
    writeFileSync(path.join(dir, 'task_metadata.json'), JSON.stringify({ tokenBudget: 0 }));
    expect(resolveTaskTokenBudget(dir, { tokenBudget: 100 })).toBeUndefined();
  });
});
