import { useTranslation } from 'react-i18next';
import { useSettingsStore, saveSettings } from '../../stores/settings-store';
import { MixedPhaseEditor } from './MixedPhaseEditor';
import { MixedFeatureEditor } from './MixedFeatureEditor';

/**
 * CrossProviderTabContent — rendered when the user selects the "Cross-Provider" tab
 * in Agent Profile settings.
 *
 */
export function CrossProviderTabContent() {
  const { t } = useTranslation('settings');
  const settings = useSettingsStore((s) => s.settings);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <h4 className="font-medium text-sm text-foreground">
          {t('agentProfile.crossProviderTab.title')}
        </h4>
        <p className="text-sm text-muted-foreground">
          {t('agentProfile.crossProviderTab.description')}
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={!!settings.customMixedProfileActive}
          onChange={event => void saveSettings({ customMixedProfileActive: event.target.checked })} />
        {t('agentProfile.crossProviderTab.activateInfo')}
      </label>

      {/* Pipeline Phase Configuration */}
      <div className="rounded-lg border border-border bg-card p-4">
        <h4 className="font-medium text-sm text-foreground mb-1">
          {t('agentProfile.phaseConfiguration')}
        </h4>
        <p className="text-xs text-muted-foreground mb-4">
          {t('agentProfile.phaseConfigurationDescription')}
        </p>
        <MixedPhaseEditor />
      </div>

      {/* Feature Model Configuration */}
      <div className="rounded-lg border border-border bg-card p-4">
        <h4 className="font-medium text-sm text-foreground mb-1">
          {t('agentProfile.crossProviderTab.featureModelsTitle')}
        </h4>
        <p className="text-xs text-muted-foreground mb-4">
          {t('agentProfile.crossProviderTab.featureModelsDescription')}
        </p>
        <MixedFeatureEditor />
      </div>
    </div>
  );
}
