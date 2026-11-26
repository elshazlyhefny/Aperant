import { taskAgentPreset } from '@shared/utils/task-agent';
import { useTranslation } from 'react-i18next';
import { useSettingsStore, saveSettings } from '../../stores/settings-store';
import { MultiProviderModelSelect } from './MultiProviderModelSelect';
import { ThinkingLevelSelect } from './ThinkingLevelSelect';
import { ALL_AVAILABLE_MODELS } from '@shared/constants/models';
import { PROVIDER_REGISTRY } from '@shared/constants/providers';
import { PHASE_KEYS } from '@shared/constants/models';
import { Label } from '../ui/label';
import type { MixedPhaseConfig, TaskAgentMode, PipelinePhase, ThinkingLevel } from '@shared/types/settings';
import type { BuiltinProvider } from '@shared/types/provider-account';

/**
 * Default config used when customMixedPhaseConfig is not set.
 * All phases use Anthropic/opus/high.
 */
const DEFAULT_MIXED_PHASE_CONFIG: MixedPhaseConfig = {
  spec: { provider: 'anthropic', modelId: 'opus', thinkingLevel: 'high' },
  planning: { provider: 'anthropic', modelId: 'opus', thinkingLevel: 'high' },
  coding: { provider: 'anthropic', modelId: 'opus', thinkingLevel: 'high' },
  qa: { provider: 'anthropic', modelId: 'opus', thinkingLevel: 'high' },
};

/**
 * Resolve the provider for a given model ID from ALL_AVAILABLE_MODELS.
 * Falls back to 'anthropic' if not found.
 */
function resolveProviderForModel(modelId: string): BuiltinProvider {
  const found = ALL_AVAILABLE_MODELS.find((m) => m.value === modelId);
  return found?.provider ?? 'anthropic';
}

/**
 * Get a short display name for a provider from PROVIDER_REGISTRY.
 */
function getProviderName(provider: BuiltinProvider): string {
  return PROVIDER_REGISTRY.find((p) => p.id === provider)?.name ?? provider;
}

/**
 * Provider badge shown next to each phase row.
 */
function ProviderBadge({ provider }: { provider: BuiltinProvider }) {
  return (
    <span className="inline-flex items-center rounded bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground whitespace-nowrap">
      {getProviderName(provider)}
    </span>
  );
}

/**
 * MixedPhaseEditor — shown when "Custom (Cross-Provider)" profile is active.
 *
 * Renders one row per pipeline phase (spec, planning, coding, qa).
 * Each row lets the user pick a model from any provider, a thinking level
 * adapted to that provider, and displays a provider badge.
 */
export function MixedPhaseEditor() {
  const settings = useSettingsStore((s) => s.settings);

  return <PhaseEditor config={settings.customMixedPhaseConfig ?? DEFAULT_MIXED_PHASE_CONFIG}
    onChange={customMixedPhaseConfig => void saveSettings({ customMixedPhaseConfig })} />;
}

export function PhaseEditor({ config, onChange, mode }: {
  config: MixedPhaseConfig;
  onChange: (config: MixedPhaseConfig) => void;
  mode?: TaskAgentMode;
}) {
  const { t } = useTranslation('settings');
  const settings = useSettingsStore(s => s.settings);
  const handleModelChange = (phase: PipelinePhase, modelId: string) => {
    const provider = mode ? config[phase].provider : resolveProviderForModel(modelId);
    onChange({ ...config, [phase]: { ...config[phase], provider, modelId } });
  };

  return (
    <div className="space-y-6">
      {(PHASE_KEYS as readonly PipelinePhase[]).map((phase) => {
        const entry = config[phase];

        return (
          <div key={phase} className="space-y-3">
            {/* Phase label + description */}
            <div>
              <Label className="text-sm font-medium text-foreground">
                {t(`agentProfile.phases.${phase}.label` as Parameters<typeof t>[0])}
              </Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t(`agentProfile.phases.${phase}.description` as Parameters<typeof t>[0])}
              </p>
            </div>

            {/* 3-column grid: Model | Thinking | Provider badge */}
            <div className="grid grid-cols-[1fr_1fr_auto] gap-3 items-end">
              {/* Model selector (all providers, no filtering) */}
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">
                  {t('agentProfile.model', { defaultValue: 'Model' })}
                </span>
                <MultiProviderModelSelect
                  filterProvider={mode ? entry.provider : undefined}
                  value={entry.modelId}
                  onChange={(modelId) => handleModelChange(phase, modelId)}
                />
              </div>

              {/* Thinking level selector, adapted to provider */}
              <ThinkingLevelSelect
                value={entry.thinkingLevel}
                onChange={level => onChange({ ...config, [phase]: { ...entry, thinkingLevel: level as ThinkingLevel } })}
                modelValue={entry.modelId}
                provider={entry.provider}
              />

              {/* Provider badge */}
              <div className="pb-0.5">
                {mode === 'both' ? (
                  <select className="rounded border bg-background p-1 text-xs"
                    aria-label={t('taskAgent.phaseAgent', { phase: t(`agentProfile.phases.${phase}.label`) })}
                    value={entry.provider} onChange={event => {
                      const preset = taskAgentPreset(event.target.value === 'openai' ? 'codex' : 'claude', settings);
                      onChange({ ...config, [phase]: preset.phases[phase] });
                    }}>
                    <option value="anthropic">{t('taskAgent.claude')}</option>
                    <option value="openai">{t('taskAgent.codex')}</option>
                  </select>
                ) : <ProviderBadge provider={entry.provider} />}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
