import { getProviderPresetOrFallback } from '../constants/models';
import type { AppSettings, MixedPhaseConfig, PipelinePhase, TaskAgentMode, TaskAgentSelection } from '../types/settings';
import type { TaskMetadata } from '../types/task';

function phases<T>(entry: (phase: PipelinePhase) => T): Record<PipelinePhase, T> {
  return { spec: entry('spec'), planning: entry('planning'), coding: entry('coding'), qa: entry('qa') };
}

export function taskAgentPreset(mode: TaskAgentMode, settings: Partial<AppSettings>): TaskAgentSelection {
  const configByPhase: MixedPhaseConfig = phases(phase => {
    const provider = mode === 'codex' || (mode === 'both' && phase === 'coding') ? 'openai' : 'anthropic';
    const config = settings.providerAgentConfig?.[provider];
    const preset = getProviderPresetOrFallback(provider, config?.selectedAgentProfile ?? settings.selectedAgentProfile ?? 'auto');
    return {
      provider,
      modelId: config?.customPhaseModels?.[phase] || preset.phaseModels[phase],
      thinkingLevel: config?.customPhaseThinking?.[phase] ?? preset.phaseThinking[phase],
    };
  });
  return { mode, phases: configByPhase };
}

export function taskPhaseMetadata(config: MixedPhaseConfig) {
  return {
    provider: config.spec.provider,
    model: config.spec.modelId,
    thinkingLevel: config.spec.thinkingLevel,
    isAutoProfile: true,
    phaseProviders: phases(phase => config[phase].provider),
    phaseModels: phases(phase => config[phase].modelId),
    phaseThinking: phases(phase => config[phase].thinkingLevel),
  };
}

export function savedTaskAgent(metadata?: TaskMetadata): TaskAgentSelection | null {
  const mode = metadata?.taskAgentMode;
  if (!mode || !metadata.phaseProviders || !metadata.phaseModels || !metadata.phaseThinking) return null;
  const { phaseProviders, phaseModels, phaseThinking } = metadata;
  return { mode, phases: phases(phase => ({
    provider: phaseProviders[phase] === 'openai' ? 'openai' : 'anthropic',
    modelId: phaseModels[phase],
    thinkingLevel: phaseThinking[phase],
  })) };
}
