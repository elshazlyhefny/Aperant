import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';
import { DEFAULT_APP_SETTINGS } from '../../../shared/constants/config';
import type { AppSettings, IssueWritebackProviderKey, IssueWritebackSettings as IssueWritebackConfig } from '../../../shared/types';

interface IssueWritebackSettingsProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

const DEFAULT_ISSUE_WRITEBACK = DEFAULT_APP_SETTINGS.issueWriteback as IssueWritebackConfig;

const MAX_STATE_NAME_LENGTH = 100;

const TOGGLE_ITEMS: Array<{ key: IssueWritebackProviderKey; labelKey: string; descriptionKey: string }> = [
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
        <Fragment key={item.key}>
          <div className="flex items-center justify-between p-4 rounded-lg border border-border">
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

          {item.key === 'linear' && (
            <div className="space-y-3 p-4 rounded-lg border border-border">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <Label htmlFor="issue-writeback-linearTransitionOnReview" className="font-medium text-foreground">
                    {t('notifications.issueWriteback.linearTransitionOnReview')}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t('notifications.issueWriteback.linearTransitionOnReviewDescription')}
                  </p>
                </div>
                <Switch
                  id="issue-writeback-linearTransitionOnReview"
                  checked={issueWriteback.linearTransitionOnReview}
                  onCheckedChange={(checked) => update({ linearTransitionOnReview: checked })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="issue-writeback-linear-state-name" className="font-medium text-foreground">
                  {t('notifications.issueWriteback.linearStateNameLabel')}
                </Label>
                <Input
                  id="issue-writeback-linear-state-name"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={MAX_STATE_NAME_LENGTH}
                  placeholder={t('notifications.issueWriteback.linearStateNamePlaceholder')}
                  value={issueWriteback.linearTransitionStateName}
                  disabled={!issueWriteback.linearTransitionOnReview}
                  onChange={(e) => update({ linearTransitionStateName: e.target.value })}
                />
              </div>
            </div>
          )}
        </Fragment>
      ))}

      <p className="text-xs text-muted-foreground">{t('notifications.issueWriteback.note')}</p>
    </div>
  );
}
