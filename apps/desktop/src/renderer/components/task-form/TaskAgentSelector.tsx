import { useTranslation } from 'react-i18next';
import type { TaskAgentMode, TaskAgentSelection } from '@shared/types/settings';
import { taskAgentPreset } from '@shared/utils/task-agent';
import { useSettingsStore } from '../../stores/settings-store';
import { PhaseEditor } from '../settings/MixedPhaseEditor';

export function TaskAgentSelector({ value, onChange, isDefault, allowProfile = true, disabled }: {
  value?: TaskAgentSelection | null;
  onChange: (selection: TaskAgentSelection | null) => void;
  isDefault?: boolean;
  allowProfile?: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation('settings');
  const settings = useSettingsStore(s => s.settings);
  return (
    <fieldset disabled={disabled} className="space-y-2">
      <label className="flex items-center gap-3 text-sm font-medium">
        {t(isDefault ? 'taskAgent.defaultLabel' : 'taskAgent.label')}
        <select className="rounded-md border border-input bg-background px-3 py-2"
          value={value?.mode ?? 'profile'}
          onChange={event => {
            const mode = event.target.value;
            onChange(mode === 'profile' ? null : taskAgentPreset(mode as TaskAgentMode, settings));
          }}>
          {allowProfile && <option value="profile">{t('taskAgent.profile')}</option>}
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
          <option value="both">{t('taskAgent.both')}</option>
        </select>
      </label>
      {value && (
        <details>
          <summary className="cursor-pointer text-sm text-muted-foreground">{t('taskAgent.customize')}</summary>
          <div className="pt-3">
            <PhaseEditor config={value.phases} mode={value.mode}
              onChange={phases => onChange({ mode: value.mode, phases })} />
          </div>
        </details>
      )}
    </fieldset>
  );
}
