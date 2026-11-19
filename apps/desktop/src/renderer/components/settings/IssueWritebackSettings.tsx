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

/** Providers that can also move the issue/work item to a named state when the task is ready for review. */
interface TransitionConfig {
  switchId: string;
  inputId: string;
  onReviewKey: 'linearTransitionOnReview' | 'azureBoardsTransitionOnReview';
  stateNameKey: 'linearTransitionStateName' | 'azureBoardsTransitionStateName';
  onReviewLabelKey: string;
  onReviewDescriptionKey: string;
  stateLabelKey: string;
  statePlaceholderKey: string;
}

const TRANSITIONS: Partial<Record<IssueWritebackProviderKey, TransitionConfig>> = {
  linear: {
    switchId: 'issue-writeback-linearTransitionOnReview',
    inputId: 'issue-writeback-linear-state-name',
    onReviewKey: 'linearTransitionOnReview',
    stateNameKey: 'linearTransitionStateName',
    onReviewLabelKey: 'notifications.issueWriteback.linearTransitionOnReview',
    onReviewDescriptionKey: 'notifications.issueWriteback.linearTransitionOnReviewDescription',
    stateLabelKey: 'notifications.issueWriteback.linearStateNameLabel',
    statePlaceholderKey: 'notifications.issueWriteback.linearStateNamePlaceholder'
  },
  azureboards: {
    switchId: 'issue-writeback-azureBoardsTransitionOnReview',
    inputId: 'issue-writeback-azureboards-state-name',
    onReviewKey: 'azureBoardsTransitionOnReview',
    stateNameKey: 'azureBoardsTransitionStateName',
    onReviewLabelKey: 'notifications.issueWriteback.azureBoardsTransitionOnReview',
    onReviewDescriptionKey: 'notifications.issueWriteback.azureBoardsTransitionOnReviewDescription',
    stateLabelKey: 'notifications.issueWriteback.azureBoardsStateNameLabel',
    statePlaceholderKey: 'notifications.issueWriteback.azureBoardsStateNamePlaceholder'
  }
};

const TOGGLE_ITEMS: Array<{ key: IssueWritebackProviderKey; labelKey: string; descriptionKey: string }> = [
  { key: 'github', labelKey: 'notifications.issueWriteback.github', descriptionKey: 'notifications.issueWriteback.githubDescription' },
  { key: 'gitlab', labelKey: 'notifications.issueWriteback.gitlab', descriptionKey: 'notifications.issueWriteback.gitlabDescription' },
  { key: 'linear', labelKey: 'notifications.issueWriteback.linear', descriptionKey: 'notifications.issueWriteback.linearDescription' },
  { key: 'azureboards', labelKey: 'notifications.issueWriteback.azureboards', descriptionKey: 'notifications.issueWriteback.azureboardsDescription' }
];

/**
 * zeenha fork: settings block for reporting task outcomes back to the GitHub/GitLab/Linear/Azure Boards item a task was imported from.
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

      {TOGGLE_ITEMS.map((item) => {
        const transition = TRANSITIONS[item.key];
        return (
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

            {transition && (
              <div className="space-y-3 p-4 rounded-lg border border-border">
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <Label htmlFor={transition.switchId} className="font-medium text-foreground">
                      {t(transition.onReviewLabelKey)}
                    </Label>
                    <p className="text-sm text-muted-foreground">{t(transition.onReviewDescriptionKey)}</p>
                  </div>
                  <Switch
                    id={transition.switchId}
                    checked={issueWriteback[transition.onReviewKey]}
                    onCheckedChange={(checked) => update({ [transition.onReviewKey]: checked })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={transition.inputId} className="font-medium text-foreground">
                    {t(transition.stateLabelKey)}
                  </Label>
                  <Input
                    id={transition.inputId}
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={MAX_STATE_NAME_LENGTH}
                    placeholder={t(transition.statePlaceholderKey)}
                    value={issueWriteback[transition.stateNameKey]}
                    disabled={!issueWriteback[transition.onReviewKey]}
                    onChange={(e) => update({ [transition.stateNameKey]: e.target.value })}
                  />
                </div>
              </div>
            )}
          </Fragment>
        );
      })}

      <p className="text-xs text-muted-foreground">{t('notifications.issueWriteback.note')}</p>
    </div>
  );
}
