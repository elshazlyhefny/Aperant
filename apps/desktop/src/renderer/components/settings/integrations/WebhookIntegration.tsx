import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Send, RefreshCw, CheckCircle2, AlertCircle } from 'lucide-react';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Switch } from '../../ui/switch';
import { DEFAULT_APP_SETTINGS } from '../../../../shared/constants/config';
import type { ProjectEnvConfig, WebhookSettings as WebhookConfig } from '../../../../shared/types';

interface WebhookIntegrationProps {
  envConfig: ProjectEnvConfig | null;
  updateEnvConfig: (updates: Partial<ProjectEnvConfig>) => void;
}

const MAX_URL_LENGTH = 2048;
const DEFAULT_EVENTS = (DEFAULT_APP_SETTINGS.webhook as WebhookConfig).events;

/** Mirrors the main-process validateWebhookUrl rules (https, or http on loopback). */
function isValidWebhookUrl(url: string): boolean {
  if (!url || url.length > MAX_URL_LENGTH) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol === 'http:') {
    return ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  }
  return false;
}

type EventKey = keyof WebhookConfig['events'];

const EVENT_ITEMS: Array<{ key: EventKey; labelKey: string; descriptionKey: string }> = [
  { key: 'reviewReady', labelKey: 'notifications.webhook.events.reviewReady', descriptionKey: 'notifications.webhook.events.reviewReadyDescription' },
  { key: 'failed', labelKey: 'notifications.webhook.events.failed', descriptionKey: 'notifications.webhook.events.failedDescription' },
  { key: 'blocked', labelKey: 'notifications.webhook.events.blocked', descriptionKey: 'notifications.webhook.events.blockedDescription' },
  { key: 'prOpened', labelKey: 'notifications.webhook.events.prOpened', descriptionKey: 'notifications.webhook.events.prOpenedDescription' }
];

/**
 * Per-project task-outcome webhook settings. Overrides the app-wide webhook.
 */
export function WebhookIntegration({ envConfig, updateEnvConfig }: WebhookIntegrationProps) {
  const { t } = useTranslation('settings');
  const [showUrl, setShowUrl] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<'success' | 'failure' | null>(null);

  if (!envConfig) return null;

  const url = envConfig.webhookUrl ?? '';
  const events = { ...DEFAULT_EVENTS, ...(envConfig.webhookEvents ?? {}) };
  const trimmedUrl = url.trim();
  const urlInvalid = trimmedUrl.length > 0 && !isValidWebhookUrl(trimmedUrl);
  const canTest = trimmedUrl.length > 0 && !urlInvalid && !isTesting;

  const handleTest = async () => {
    if (!canTest) return;
    setIsTesting(true);
    setTestResult(null);
    try {
      const result = await window.electronAPI.sendTestWebhook(trimmedUrl);
      setTestResult(result.success ? 'success' : 'failure');
    } catch {
      setTestResult('failure');
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label htmlFor="project-webhook-enabled" className="font-normal text-foreground">
            {t('projectSections.webhook.enable')}
          </Label>
          <p className="text-xs text-muted-foreground">{t('projectSections.webhook.enableDescription')}</p>
        </div>
        <Switch
          id="project-webhook-enabled"
          checked={!!envConfig.webhookEnabled}
          onCheckedChange={(checked) => updateEnvConfig({ webhookEnabled: checked })}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="project-webhook-url" className="text-sm font-medium text-foreground">
          {t('projectSections.webhook.urlLabel')}
        </Label>
        <div className="flex gap-2">
          <Input
            id="project-webhook-url"
            type={showUrl ? 'url' : 'password'}
            autoComplete="off"
            spellCheck={false}
            placeholder={t('projectSections.webhook.urlPlaceholder')}
            value={url}
            aria-invalid={urlInvalid}
            onChange={(e) => {
              setTestResult(null);
              updateEnvConfig({ webhookUrl: e.target.value });
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => setShowUrl((v) => !v)}
            aria-label={showUrl ? t('projectSections.webhook.hide') : t('projectSections.webhook.show')}
          >
            {showUrl ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
        </div>
        {urlInvalid && (
          <p role="alert" className="text-xs text-destructive">
            {t('projectSections.webhook.urlInvalid')}
          </p>
        )}
        <p className="text-xs text-muted-foreground">{t('projectSections.webhook.overrideNote')}</p>
        <p className="text-xs text-muted-foreground">{t('projectSections.webhook.storedProtectedNote')}</p>

        <div className="flex items-center gap-3 pt-2">
          <Button type="button" size="sm" variant="outline" onClick={handleTest} disabled={!canTest}>
            {isTesting ? (
              <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Send className="mr-2 h-4 w-4" />
            )}
            {isTesting ? t('projectSections.webhook.sending') : t('projectSections.webhook.sendTest')}
          </Button>
          {testResult === 'success' && (
            <span role="status" className="flex items-center gap-1 text-sm text-success">
              <CheckCircle2 className="h-4 w-4" />
              {t('projectSections.webhook.testSuccess')}
            </span>
          )}
          {testResult === 'failure' && (
            <span role="status" className="flex items-center gap-1 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              {t('projectSections.webhook.testFailed')}
            </span>
          )}
        </div>
      </div>

      {EVENT_ITEMS.map((item) => (
        <div key={item.key} className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor={`project-webhook-event-${item.key}`} className="font-normal text-foreground">
              {t(item.labelKey)}
            </Label>
            <p className="text-xs text-muted-foreground">{t(item.descriptionKey)}</p>
          </div>
          <Switch
            id={`project-webhook-event-${item.key}`}
            checked={events[item.key]}
            onCheckedChange={(checked) =>
              updateEnvConfig({ webhookEvents: { ...events, [item.key]: checked } })
            }
          />
        </div>
      ))}
    </div>
  );
}
