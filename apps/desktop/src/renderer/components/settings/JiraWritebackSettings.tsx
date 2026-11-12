import { useTranslation } from 'react-i18next';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';
import { DEFAULT_APP_SETTINGS } from '../../../shared/constants/config';
import type { AppSettings, JiraWritebackSettings as JiraWritebackConfig } from '../../../shared/types';

interface JiraWritebackSettingsProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

const MAX_STATUS_NAME_LENGTH = 100;
const DEFAULT_JIRA_WRITEBACK = DEFAULT_APP_SETTINGS.jiraWriteback as JiraWritebackConfig;

type ToggleKey = 'enabled' | 'comment' | 'transitionOnReview';

const TOGGLE_ITEMS: Array<{ key: ToggleKey; labelKey: string; descriptionKey: string }> = [
  { key: 'enabled', labelKey: 'notifications.jiraWriteback.enable', descriptionKey: 'notifications.jiraWriteback.enableDescription' },
  { key: 'comment', labelKey: 'notifications.jiraWriteback.comment', descriptionKey: 'notifications.jiraWriteback.commentDescription' },
  { key: 'transitionOnReview', labelKey: 'notifications.jiraWriteback.transitionOnReview', descriptionKey: 'notifications.jiraWriteback.transitionOnReviewDescription' }
];

/**
 * zeenha fork: settings block for reporting task outcomes back to the Jira issue a task was imported from.
 */
export function JiraWritebackSettings({ settings, onSettingsChange }: JiraWritebackSettingsProps) {
  const { t } = useTranslation('settings');
  const jiraWriteback: JiraWritebackConfig = {
    ...DEFAULT_JIRA_WRITEBACK,
    ...(settings.jiraWriteback ?? {})
  };

  const update = (patch: Partial<JiraWritebackConfig>) => {
    onSettingsChange({ ...settings, jiraWriteback: { ...jiraWriteback, ...patch } });
  };

  return (
    <div className="space-y-4 pt-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-foreground">{t('notifications.jiraWriteback.title')}</h3>
        <p className="text-sm text-muted-foreground">{t('notifications.jiraWriteback.description')}</p>
      </div>

      {TOGGLE_ITEMS.map((item) => (
        <div key={item.key} className="flex items-center justify-between p-4 rounded-lg border border-border">
          <div className="space-y-1">
            <Label htmlFor={`jira-writeback-${item.key}`} className="font-medium text-foreground">
              {t(item.labelKey)}
            </Label>
            <p className="text-sm text-muted-foreground">{t(item.descriptionKey)}</p>
          </div>
          <Switch
            id={`jira-writeback-${item.key}`}
            checked={jiraWriteback[item.key]}
            onCheckedChange={(checked) => update({ [item.key]: checked })}
          />
        </div>
      ))}

      <div className="space-y-2 p-4 rounded-lg border border-border">
        <Label htmlFor="jira-writeback-status-name" className="font-medium text-foreground">
          {t('notifications.jiraWriteback.statusNameLabel')}
        </Label>
        <Input
          id="jira-writeback-status-name"
          type="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={MAX_STATUS_NAME_LENGTH}
          placeholder={t('notifications.jiraWriteback.statusNamePlaceholder')}
          value={jiraWriteback.transitionStatusName}
          disabled={!jiraWriteback.transitionOnReview}
          onChange={(e) => update({ transitionStatusName: e.target.value })}
        />
        <p className="text-xs text-muted-foreground">{t('notifications.jiraWriteback.note')}</p>
      </div>
    </div>
  );
}
