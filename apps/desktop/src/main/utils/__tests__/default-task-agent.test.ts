import { describe, expect, it } from 'vitest';
import type { AppSettings, MixedPhaseConfig, TaskAgentSelection } from '../../../shared/types/settings';
import type { TaskMetadata } from '../../../shared/types/task';
import { applyDefaultTaskAgent } from '../default-task-agent';

const codexDefault: TaskAgentSelection = {
  mode: 'codex',
  phases: {
    spec: { provider: 'openai', modelId: 'gpt-spec', thinkingLevel: 'medium' },
    planning: { provider: 'openai', modelId: 'gpt-plan', thinkingLevel: 'high' },
    coding: { provider: 'openai', modelId: 'gpt-code', thinkingLevel: 'medium' },
    qa: { provider: 'openai', modelId: 'gpt-qa', thinkingLevel: 'low' },
  },
};

const settings: Partial<AppSettings> = { defaultTaskAgent: codexDefault };

describe('applyDefaultTaskAgent', () => {
  it('returns the metadata unchanged when no default task agent is set', () => {
    const metadata: TaskMetadata = { sourceType: 'github', githubIssueNumber: 7 };
    expect(applyDefaultTaskAgent(metadata, undefined)).toEqual(metadata);
    expect(applyDefaultTaskAgent(metadata, {})).toEqual(metadata);
    expect(applyDefaultTaskAgent(metadata, { defaultTaskAgent: null })).toEqual(metadata);
  });

  it('fills per-phase routing from the default when the metadata has no agent', () => {
    const result = applyDefaultTaskAgent({ sourceType: 'github', githubIssueNumber: 7 }, settings);

    expect(result).toMatchObject({
      sourceType: 'github',
      githubIssueNumber: 7,
      taskAgentMode: 'codex',
      provider: 'openai',
      model: 'gpt-spec',
      thinkingLevel: 'medium',
      isAutoProfile: true,
      phaseProviders: { spec: 'openai', planning: 'openai', coding: 'openai', qa: 'openai' },
      phaseModels: { spec: 'gpt-spec', planning: 'gpt-plan', coding: 'gpt-code', qa: 'gpt-qa' },
      phaseThinking: { spec: 'medium', planning: 'high', coding: 'medium', qa: 'low' },
    });
  });

  describe('active cross-provider (mixed) profile', () => {
    const mixed: MixedPhaseConfig = {
      spec: { provider: 'anthropic', modelId: 'opus', thinkingLevel: 'high' },
      planning: { provider: 'anthropic', modelId: 'opus', thinkingLevel: 'high' },
      coding: { provider: 'openai', modelId: 'gpt-code', thinkingLevel: 'high' },
      qa: { provider: 'anthropic', modelId: 'opus', thinkingLevel: 'low' },
    };
    const mixedSettings: Partial<AppSettings> = { customMixedProfileActive: true, customMixedPhaseConfig: mixed };

    it('applies the mixed profile when no default task agent is set', () => {
      const result = applyDefaultTaskAgent<TaskMetadata>({ sourceType: 'ideation' }, mixedSettings);

      expect(result).toMatchObject({
        sourceType: 'ideation',
        provider: 'anthropic',
        model: 'opus',
        isAutoProfile: true,
        phaseProviders: { spec: 'anthropic', planning: 'anthropic', coding: 'openai', qa: 'anthropic' },
        phaseModels: { spec: 'opus', planning: 'opus', coding: 'gpt-code', qa: 'opus' },
        phaseThinking: { spec: 'high', planning: 'high', coding: 'high', qa: 'low' },
      });
      expect(result.taskAgentMode).toBeUndefined();
    });

    it('prefers the default task agent over the mixed profile', () => {
      const result = applyDefaultTaskAgent({ sourceType: 'roadmap' }, { ...mixedSettings, defaultTaskAgent: codexDefault });
      expect(result).toMatchObject({ taskAgentMode: 'codex', phaseModels: { planning: 'gpt-plan' } });
    });

    it('ignores a saved mixed profile that is not active', () => {
      const metadata: TaskMetadata = { sourceType: 'roadmap' };
      expect(applyDefaultTaskAgent(metadata, { customMixedProfileActive: false, customMixedPhaseConfig: mixed })).toEqual(metadata);
    });

    it('leaves an explicit task choice untouched', () => {
      const metadata: TaskMetadata = { sourceType: 'manual', model: 'sonnet' };
      expect(applyDefaultTaskAgent(metadata, mixedSettings)).toEqual(metadata);
    });
  });

  it('does not mutate the input metadata', () => {
    const metadata: TaskMetadata = { sourceType: 'jira' };
    applyDefaultTaskAgent(metadata, settings);
    expect(metadata).toEqual({ sourceType: 'jira' });
  });

  it.each<[string, TaskMetadata]>([
    ['an explicit task agent', { sourceType: 'manual', taskAgentMode: 'claude' }],
    ['explicit phase providers', { sourceType: 'manual', phaseProviders: { coding: 'anthropic' } }],
    ['explicit phase models', { sourceType: 'manual', phaseModels: { spec: 'opus', planning: 'opus', coding: 'opus', qa: 'opus' } }],
    ['an explicit provider', { sourceType: 'manual', provider: 'anthropic' }],
    ['an explicit model', { sourceType: 'manual', model: 'opus' }],
  ])('leaves metadata with %s untouched', (_label, metadata) => {
    expect(applyDefaultTaskAgent(metadata, settings)).toEqual(metadata);
  });
});
