import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Send, RefreshCw, CheckCircle2, AlertCircle } from 'lucide-react';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Switch } from '../../ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select';
import { DEFAULT_APP_SETTINGS } from '../../../../shared/constants/config';
import { detectWebhookFormat, isWebhookFormat } from '../../../../shared/utils/webhook-format';
import type { ProjectEnvConfig, WebhookSettings as WebhookConfig } from '../../../../shared/types';

interface WebhookIntegrationProps {
  projectId: string;
  envConfig: ProjectEnvConfig | null;
  updateEnvConfig: (updates: Partial<ProjectEnvConfig>) => void;
}

const MAX_URL_LENGTH = 2048;
const DEFAULT_EVENTS = (DEFAULT_APP_SETTINGS.webhook as WebhookConfig).events;

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '[::1]' || host === '::1' || host === '0.0.0.0') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Mirrors the main-process validateProjectWebhookUrl rules (https only, no loopback, no credentials). */
function isValidWebhookUrl(url: string): boolean {
  if (!url || url.length > MAX_URL_LENGTH) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  if (parsed.protocol !== 'https:') return false;
  return !isLoopbackHost(parsed.hostname);
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
export function WebhookIntegration({ projectId, envConfig, updateEnvConfig }: WebhookIntegrationProps) {
  const { t } = useTranslation('settings');
  const [isApproving, setIsApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [showUrl, setShowUrl] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<'success' | 'failure' | null>(null);

  if (!envConfig) return null;

  const url = envConfig.webhookUrl ?? '';
  const events = { ...DEFAULT_EVENTS, ...(envConfig.webhookEvents ?? {}) };
  const trimmedUrl = url.trim();
  const urlInvalid = trimmedUrl.length > 0 && !isValidWebhookUrl(trimmedUrl);
  const selectedFormat = isWebhookFormat(envConfig.webhookFormat) ? envConfig.webhookFormat : 'auto';
  const approval = envConfig.webhookApproval;
  const unchanged = !!approval && trimmedUrl === approval.url;
  const isUnapproved = unchanged && approval?.status === 'unapproved';
  const isRefused = unchanged && approval?.status === 'refused';
  const isApproved = unchanged && approval?.status === 'approved';
  const isEdited = !!approval && !unchanged && trimmedUrl.length > 0;
  const canTest = trimmedUrl.length > 0 && !urlInvalid && !isTesting && !isUnapproved && !isRefused;

  const handleApprove = async () => {
    if (!approval || isApproving) return;
    setIsApproving(true);
    setApproveError(null);
    try {
      const result = await window.electronAPI.approveProjectWebhook(projectId, approval.hash);
      if (result.success) {
        updateEnvConfig({ webhookApproval: { ...approval, status: 'approved' } });
      } else {
        setApproveError(result.error ?? '');
      }
    } catch (error) {
      setApproveError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsApproving(false);
    }
  };

  const handleTest = async () => {
    if (!canTest) return;
    setIsTesting(true);
    setTestResult(null);
    try {
      const result = await window.electronAPI.sendTestWebhook(trimmedUrl, selectedFormat);
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
        {urlInvalid && !isRefused && (
          <p role="alert" className="text-xs text-destructive">
            {t('projectSections.webhook.urlInvalid')}
          </p>
        )}
        {isUnapproved && approval && (
          <div className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3">
            <p className="text-sm font-medium text-foreground">{t('projectSections.webhook.unapprovedTitle')}</p>
            <p className="break-all rounded bg-muted p-2 font-mono text-xs text-foreground">{approval.url}</p>
            <p className="text-xs text-muted-foreground">{t('projectSections.webhook.unapprovedDescription')}</p>
            {approveError !== null && (
              <p role="alert" className="text-xs text-destructive">
                {t('projectSections.webhook.approveFailed', { error: approveError })}
              </p>
            )}
            <Button type="button" size="sm" onClick={handleApprove} disabled={isApproving}>
              {isApproving ? t('projectSections.webhook.approving') : t('projectSections.webhook.approve')}
            </Button>
          </div>
        )}
        {isRefused && (
          <p role="alert" className="text-xs text-destructive">
            {t('projectSections.webhook.refusedLoopback')}
          </p>
        )}
        {isApproved && (
          <p role="status" className="text-xs text-success">{t('projectSections.webhook.approved')}</p>
        )}
        {isEdited && (
          <p className="text-xs text-muted-foreground">{t('projectSections.webhook.fallbackNote')}</p>
        )}

        <div className="space-y-1 pt-2">
          <Label htmlFor="project-webhook-format" className="text-sm font-medium text-foreground">
            {t('projectSections.webhook.format.label')}
          </Label>
          <Select value={selectedFormat} onValueChange={(value) => {
              setTestResult(null);
              updateEnvConfig({ webhookFormat: value as ProjectEnvConfig['webhookFormat'] });
            }}>
            <SelectTrigger id="project-webhook-format">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{t('projectSections.webhook.format.auto')}</SelectItem>
              <SelectItem value="slack">{t('projectSections.webhook.format.slack')}</SelectItem>
              <SelectItem value="teams">{t('projectSections.webhook.format.teams')}</SelectItem>
              <SelectItem value="discord">{t('projectSections.webhook.format.discord')}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t('projectSections.webhook.format.description')}</p>
          {selectedFormat === 'auto' && trimmedUrl.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {t('projectSections.webhook.format.detected', { format: t(`projectSections.webhook.format.${detectWebhookFormat(trimmedUrl)}`) })}
            </p>
          )}
        </div>
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
