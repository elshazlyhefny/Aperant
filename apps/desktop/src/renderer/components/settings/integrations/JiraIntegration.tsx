import { Import, Eye, EyeOff, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Switch } from '../../ui/switch';
import type { ProjectEnvConfig, JiraSyncStatus } from '../../../../shared/types';

interface JiraIntegrationProps {
  envConfig: ProjectEnvConfig | null;
  updateEnvConfig: (updates: Partial<ProjectEnvConfig>) => void;
  showJiraToken: boolean;
  setShowJiraToken: React.Dispatch<React.SetStateAction<boolean>>;
  jiraConnectionStatus: JiraSyncStatus | null;
  isCheckingJira: boolean;
  onOpenJiraImport: () => void;
}

/** True when the value is an https URL on an *.atlassian.net host. */
function isValidJiraSiteUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && url.hostname.toLowerCase().endsWith('.atlassian.net');
  } catch {
    return false;
  }
}

/**
 * Jira integration settings component.
 * Manages Jira site credentials, connection status, and the import entry point.
 */
export function JiraIntegration({
  envConfig,
  updateEnvConfig,
  showJiraToken,
  setShowJiraToken,
  jiraConnectionStatus,
  isCheckingJira,
  onOpenJiraImport
}: JiraIntegrationProps) {
  const { t } = useTranslation('jira');

  if (!envConfig) return null;

  const siteUrl = envConfig.jiraSiteUrl || '';
  const showInvalidSiteUrl = siteUrl.trim() !== '' && !isValidJiraSiteUrl(siteUrl);
  const hasCredentials = !!(siteUrl && envConfig.jiraEmail && envConfig.jiraApiToken);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label className="font-normal text-foreground">{t('settings.enable')}</Label>
          <p className="text-xs text-muted-foreground">{t('settings.enableDescription')}</p>
        </div>
        <Switch
          checked={envConfig.jiraEnabled}
          onCheckedChange={(checked) => updateEnvConfig({ jiraEnabled: checked })}
        />
      </div>

      {envConfig.jiraEnabled && (
        <>
          <div className="space-y-2">
            <Label className="text-sm font-medium text-foreground">{t('settings.siteUrl.label')}</Label>
            <p className="text-xs text-muted-foreground">{t('settings.siteUrl.help')}</p>
            <Input
              placeholder={t('settings.siteUrl.placeholder')}
              value={siteUrl}
              onChange={(e) => updateEnvConfig({ jiraSiteUrl: e.target.value })}
            />
            {showInvalidSiteUrl && (
              <p className="text-xs text-warning">{t('settings.connection.invalidSiteUrl')}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium text-foreground">{t('settings.email.label')}</Label>
            <Input
              type="email"
              placeholder={t('settings.email.placeholder')}
              value={envConfig.jiraEmail || ''}
              onChange={(e) => updateEnvConfig({ jiraEmail: e.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium text-foreground">{t('settings.apiToken.label')}</Label>
            <p className="text-xs text-muted-foreground">
              {t('settings.apiToken.help')}{' '}
              <a
                href={t('settings.apiToken.linkUrl')}
                target="_blank"
                rel="noopener noreferrer"
                className="text-info hover:underline"
              >
                {t('settings.apiToken.linkText')}
              </a>
            </p>
            <div className="relative">
              <Input
                type={showJiraToken ? 'text' : 'password'}
                value={envConfig.jiraApiToken || ''}
                onChange={(e) => updateEnvConfig({ jiraApiToken: e.target.value })}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowJiraToken(!showJiraToken)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showJiraToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium text-foreground">{t('settings.defaultProject.label')}</Label>
            <Input
              placeholder={t('settings.defaultProject.placeholder')}
              value={envConfig.jiraProjectKey || ''}
              onChange={(e) => updateEnvConfig({ jiraProjectKey: e.target.value })}
            />
          </div>

          {hasCredentials && (
            <ConnectionStatus isChecking={isCheckingJira} connectionStatus={jiraConnectionStatus} />
          )}

          {jiraConnectionStatus?.connected && (
            <Button size="sm" variant="outline" onClick={onOpenJiraImport}>
              <Import className="h-4 w-4 mr-2" />
              {t('settings.importButton')}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

interface ConnectionStatusProps {
  isChecking: boolean;
  connectionStatus: JiraSyncStatus | null;
}

function ConnectionStatus({ isChecking, connectionStatus }: ConnectionStatusProps) {
  const { t } = useTranslation('jira');

  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {isChecking
            ? t('settings.connection.checking')
            : connectionStatus?.connected
              ? t('settings.connection.connectedAs', {
                  name: connectionStatus.userName || connectionStatus.siteName || ''
                })
              : connectionStatus?.error || t('settings.connection.notConnected')}
        </p>
        {isChecking ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : connectionStatus?.connected ? (
          <CheckCircle2 className="h-4 w-4 text-success" />
        ) : (
          <AlertCircle className="h-4 w-4 text-warning" />
        )}
      </div>
    </div>
  );
}
