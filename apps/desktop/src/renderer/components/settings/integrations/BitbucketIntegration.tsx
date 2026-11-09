import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, GitBranch, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Switch } from '../../ui/switch';
import { Separator } from '../../ui/separator';
import { Button } from '../../ui/button';
import type { ProjectEnvConfig, BitbucketSyncStatus } from '../../../../shared/types';

interface BitbucketIntegrationProps {
  projectId: string;
  envConfig: ProjectEnvConfig | null;
  updateEnvConfig: (updates: Partial<ProjectEnvConfig>) => void;
  showBitbucketToken: boolean;
  setShowBitbucketToken: React.Dispatch<React.SetStateAction<boolean>>;
  bitbucketConnectionStatus: BitbucketSyncStatus | null;
  isCheckingBitbucket: boolean;
}

/**
 * Bitbucket Cloud integration settings: username, token, repository and connection status.
 */
export function BitbucketIntegration({
  projectId,
  envConfig,
  updateEnvConfig,
  showBitbucketToken,
  setShowBitbucketToken,
  bitbucketConnectionStatus,
  isCheckingBitbucket
}: BitbucketIntegrationProps) {
  const { t } = useTranslation('bitbucket');
  const [isDetecting, setIsDetecting] = useState(false);
  const [detectMessage, setDetectMessage] = useState<{ ok: boolean; text: string } | null>(null);

  if (!envConfig) return null;

  const handleDetect = async () => {
    setIsDetecting(true);
    setDetectMessage(null);
    try {
      const result = await window.electronAPI.detectBitbucketRepository(projectId);
      if (result.success && result.data) {
        updateEnvConfig({ bitbucketRepository: result.data.fullName });
        setDetectMessage({ ok: true, text: t('repository.detected', { repo: result.data.fullName }) });
      } else if (result.success) {
        setDetectMessage({ ok: false, text: t('repository.notDetected') });
      } else {
        setDetectMessage({ ok: false, text: result.error || t('repository.detectFailed') });
      }
    } catch {
      setDetectMessage({ ok: false, text: t('repository.detectFailed') });
    } finally {
      setIsDetecting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label className="font-normal text-foreground">{t('enable.label')}</Label>
          <p className="text-xs text-muted-foreground">{t('enable.description')}</p>
        </div>
        <Switch
          checked={envConfig.bitbucketEnabled}
          onCheckedChange={(checked) => updateEnvConfig({ bitbucketEnabled: checked })}
        />
      </div>

      {envConfig.bitbucketEnabled && (
        <>
          <Separator />

          <div className="space-y-2">
            <Label className="text-sm font-medium text-foreground">{t('username.label')}</Label>
            <p className="text-xs text-muted-foreground">{t('username.description')}</p>
            <Input
              placeholder={t('username.placeholder')}
              value={envConfig.bitbucketUsername || ''}
              onChange={(e) => updateEnvConfig({ bitbucketUsername: e.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium text-foreground">{t('token.label')}</Label>
            <p className="text-xs text-muted-foreground">{t('token.description')}</p>
            <div className="relative">
              <Input
                type={showBitbucketToken ? 'text' : 'password'}
                placeholder={t('token.placeholder')}
                value={envConfig.bitbucketToken || ''}
                onChange={(e) => updateEnvConfig({ bitbucketToken: e.target.value })}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowBitbucketToken((prev) => !prev)}
                aria-label={showBitbucketToken ? t('token.hide') : t('token.show')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showBitbucketToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium text-foreground">{t('repository.label')}</Label>
            <p className="text-xs text-muted-foreground">{t('repository.description')}</p>
            <div className="flex gap-2">
              <Input
                placeholder={t('repository.placeholder')}
                value={envConfig.bitbucketRepository || ''}
                onChange={(e) => updateEnvConfig({ bitbucketRepository: e.target.value })}
              />
              <Button type="button" variant="outline" onClick={handleDetect} disabled={isDetecting} className="shrink-0">
                {isDetecting ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <GitBranch className="h-4 w-4 mr-2" />
                )}
                {isDetecting ? t('repository.detecting') : t('repository.detect')}
              </Button>
            </div>
            {detectMessage && (
              <p className={`text-xs ${detectMessage.ok ? 'text-success' : 'text-destructive'}`}>{detectMessage.text}</p>
            )}
          </div>

          <Separator />

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-sm font-medium text-foreground">{t('connection.label')}</Label>
              <p className="text-xs text-muted-foreground">
                {isCheckingBitbucket
                  ? t('connection.checking')
                  : bitbucketConnectionStatus === null
                    ? t('connection.notChecked')
                    : bitbucketConnectionStatus.connected
                      ? bitbucketConnectionStatus.repoFullName
                        ? t('connection.connected', { repo: bitbucketConnectionStatus.repoFullName })
                        : t('connection.connectedGeneric')
                      : bitbucketConnectionStatus.error || t('connection.failed')}
              </p>
            </div>
            {isCheckingBitbucket ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : bitbucketConnectionStatus?.connected ? (
              <CheckCircle2 className="h-4 w-4 text-success" />
            ) : bitbucketConnectionStatus ? (
              <AlertCircle className="h-4 w-4 text-destructive" />
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
