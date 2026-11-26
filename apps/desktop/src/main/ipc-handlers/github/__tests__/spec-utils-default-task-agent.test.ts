/**
 * A GitHub issue import must carry the Settings default task agent into
 * task_metadata.json, because execution reads routing only from there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { Project } from '../../../../shared/types';
import type { AppSettings } from '../../../../shared/types/settings';

const settingsState = vi.hoisted(() => ({ value: undefined as Partial<AppSettings> | undefined }));

vi.mock('../../../settings-utils', () => ({
  readSettingsFile: () => settingsState.value,
}));

import { createSpecForIssue } from '../spec-utils';

describe('createSpecForIssue default task agent', () => {
  let projectDir: string;
  let project: Project;

  beforeEach(() => {
    projectDir = mkdtempSync(path.join(tmpdir(), 'gh-default-agent-'));
    project = { id: 'p1', name: 'p', path: projectDir, autoBuildPath: '.auto-claude' } as Project;
  });

  afterEach(() => {
    settingsState.value = undefined;
    rmSync(projectDir, { recursive: true, force: true });
  });

  const readMetadata = (specDir: string) =>
    JSON.parse(readFileSync(path.join(specDir, 'task_metadata.json'), 'utf-8'));

  it('writes the default task agent into task_metadata.json', async () => {
    settingsState.value = {
      defaultTaskAgent: {
        mode: 'codex',
        phases: {
          spec: { provider: 'openai', modelId: 'gpt-spec', thinkingLevel: 'medium' },
          planning: { provider: 'openai', modelId: 'gpt-plan', thinkingLevel: 'high' },
          coding: { provider: 'openai', modelId: 'gpt-code', thinkingLevel: 'medium' },
          qa: { provider: 'openai', modelId: 'gpt-qa', thinkingLevel: 'low' },
        },
      },
    };

    const spec = await createSpecForIssue(project, 12, 'Fix login', 'Body', 'https://github.com/o/r/issues/12');

    const written = readMetadata(spec.specDir);
    expect(written).toMatchObject({
      sourceType: 'github',
      githubIssueNumber: 12,
      taskAgentMode: 'codex',
      phaseProviders: { spec: 'openai', planning: 'openai', coding: 'openai', qa: 'openai' },
      phaseModels: { spec: 'gpt-spec', planning: 'gpt-plan', coding: 'gpt-code', qa: 'gpt-qa' },
    });
    expect(spec.metadata).toEqual(written);
  });

  it('writes no agent routing when no default is set', async () => {
    const spec = await createSpecForIssue(project, 13, 'Fix logout', 'Body', 'https://github.com/o/r/issues/13');

    const written = readMetadata(spec.specDir);
    expect(written.sourceType).toBe('github');
    expect(written.taskAgentMode).toBeUndefined();
    expect(written.phaseProviders).toBeUndefined();
    expect(written.provider).toBeUndefined();
  });
});
