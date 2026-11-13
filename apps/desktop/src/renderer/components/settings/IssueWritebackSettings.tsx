import { useTranslation } from 'react-i18next';
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';
import { DEFAULT_APP_SETTINGS } from '../../../shared/constants/config';
import type { AppSettings, IssueWritebackSettings as IssueWritebackConfig } from '../../../shared/types';

interface IssueWritebackSettingsProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

const DEFAULT_ISSUE_WRITEBACK = DEFAULT_APP_SETTINGS.issueWriteback as IssueWritebackConfig;

type ProviderKey = keyof IssueWritebackConfig;

const TOGGLE_ITEMS: Array<{ key: ProviderKey; labelKey: string; descriptionKey: string }> = [
  { key: 'github', labelKey: 'notifications.issueWriteback.github', descriptionKey: 'notifications.issueWriteback.githubDescription' },
  { key: 'gitlab', labelKey: 'notifications.issueWriteback.gitlab', descriptionKey: 'notifications.issueWriteback.gitlabDescription' },
  { key: 'linear', labelKey: 'notifications.issueWriteback.linear', descriptionKey: 'notifications.issueWriteback.linearDescription' }
];

/**
 * zeenha fork: settings block for reporting task outcomes back to the GitHub/GitLab/Linear issue a task was imported from.
 */
export function IssueWritebackSettings({ settings, onSettingsChange }: IssueWritebackSettingsProps) {
  const { t } = useTranslation('settings');
  const issueWriteback: IssueWritebackConfig = {
    ...DEFAULT_ISSUE_WRITEBACK,
    ...(settings.issueWriteback ?? {})
  };

  const update = (patch: Partial<IssueWritebackConfig>) => {
    onSettingsChange({ ...settings, issueWriteback: { ...issueWriteback, ...patch } });
  };

  return (
    <div className="space-y-4 pt-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-foreground">{t('notifications.issueWriteback.title')}</h3>
        <p className="text-sm text-muted-foreground">{t('notifications.issueWriteback.description')}</p>
      </div>

      {TOGGLE_ITEMS.map((item) => (
        <div key={item.key} className="flex items-center justify-between p-4 rounded-lg border border-border">
          <div className="space-y-1">
            <Label htmlFor={`issue-writeback-${item.key}`} className="font-medium text-foreground">
              {t(item.labelKey)}
            </Label>
            <p className="text-sm text-muted-foreground">{t(item.descriptionKey)}</p>
          </div>
          <Switch
            id={`issue-writeback-${item.key}`}
            checked={issueWriteback[item.key]}
            onCheckedChange={(checked) => update({ [item.key]: checked })}
          />
        </div>
      ))}

      <p className="text-xs text-muted-foreground">{t('notifications.issueWriteback.note')}</p>
    </div>
  );
}
