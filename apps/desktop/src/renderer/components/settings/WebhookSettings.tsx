import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Send, RefreshCw, CheckCircle2, AlertCircle } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';
import { DEFAULT_APP_SETTINGS } from '../../../shared/constants/config';
import type { AppSettings, WebhookSettings as WebhookConfig } from '../../../shared/types';

interface WebhookSettingsProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

const MAX_URL_LENGTH = 2048;
const DEFAULT_WEBHOOK = DEFAULT_APP_SETTINGS.webhook as WebhookConfig;

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
 * Settings block for the outgoing task-outcome webhook (Slack-compatible).
 */
export function WebhookSettings({ settings, onSettingsChange }: WebhookSettingsProps) {
  const { t } = useTranslation('settings');
  const webhook: WebhookConfig = {
    ...DEFAULT_WEBHOOK,
    ...(settings.webhook ?? {}),
    events: { ...DEFAULT_WEBHOOK.events, ...(settings.webhook?.events ?? {}) }
  };

  const [showUrl, setShowUrl] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<'success' | 'failure' | null>(null);

  const trimmedUrl = webhook.url.trim();
  const urlInvalid = trimmedUrl.length > 0 && !isValidWebhookUrl(trimmedUrl);
  const canTest = trimmedUrl.length > 0 && !urlInvalid && !isTesting;

  const update = (patch: Partial<WebhookConfig>) => {
    onSettingsChange({ ...settings, webhook: { ...webhook, ...patch } });
  };

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
    <div className="space-y-4 pt-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-foreground">{t('notifications.webhook.title')}</h3>
        <p className="text-sm text-muted-foreground">{t('notifications.webhook.description')}</p>
      </div>

      <div className="flex items-center justify-between p-4 rounded-lg border border-border">
        <div className="space-y-1">
          <Label htmlFor="webhook-enabled" className="font-medium text-foreground">
            {t('notifications.webhook.enable')}
          </Label>
          <p className="text-sm text-muted-foreground">{t('notifications.webhook.enableDescription')}</p>
        </div>
        <Switch
          id="webhook-enabled"
          checked={webhook.enabled}
          onCheckedChange={(checked) => update({ enabled: checked })}
        />
      </div>

      <div className="space-y-2 p-4 rounded-lg border border-border">
        <Label htmlFor="webhook-url" className="font-medium text-foreground">
          {t('notifications.webhook.urlLabel')}
        </Label>
        <div className="flex gap-2">
          <Input
            id="webhook-url"
            type={showUrl ? 'url' : 'password'}
            autoComplete="off"
            spellCheck={false}
            placeholder={t('notifications.webhook.urlPlaceholder')}
            value={webhook.url}
            aria-invalid={urlInvalid}
            onChange={(e) => {
              setTestResult(null);
              update({ url: e.target.value });
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => setShowUrl((v) => !v)}
            aria-label={showUrl ? t('notifications.webhook.hide') : t('notifications.webhook.show')}
          >
            {showUrl ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
        </div>
        {urlInvalid && (
          <p role="alert" className="text-sm text-destructive">
            {t('notifications.webhook.urlInvalid')}
          </p>
        )}
        <p className="text-xs text-muted-foreground">{t('notifications.webhook.storedLocallyNote')}</p>

        <div className="flex items-center gap-3 pt-2">
          <Button type="button" size="sm" variant="outline" onClick={handleTest} disabled={!canTest}>
            {isTesting ? (
              <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Send className="mr-2 h-4 w-4" />
            )}
            {isTesting ? t('notifications.webhook.sending') : t('notifications.webhook.sendTest')}
          </Button>
          {testResult === 'success' && (
            <span role="status" className="flex items-center gap-1 text-sm text-success">
              <CheckCircle2 className="h-4 w-4" />
              {t('notifications.webhook.testSuccess')}
            </span>
          )}
          {testResult === 'failure' && (
            <span role="status" className="flex items-center gap-1 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              {t('notifications.webhook.testFailed')}
            </span>
          )}
        </div>
      </div>

      {EVENT_ITEMS.map((item) => (
        <div key={item.key} className="flex items-center justify-between p-4 rounded-lg border border-border">
          <div className="space-y-1">
            <Label htmlFor={`webhook-event-${item.key}`} className="font-medium text-foreground">
              {t(item.labelKey)}
            </Label>
            <p className="text-sm text-muted-foreground">{t(item.descriptionKey)}</p>
          </div>
          <Switch
            id={`webhook-event-${item.key}`}
            checked={webhook.events[item.key]}
            onCheckedChange={(checked) =>
              update({ events: { ...webhook.events, [item.key]: checked } })
            }
          />
        </div>
      ))}
    </div>
  );
}
