// zeenha fork: Azure DevOps project settings section, not present upstream.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, GitBranch, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Switch } from '../../ui/switch';
import { Separator } from '../../ui/separator';
import { Button } from '../../ui/button';
import type { ProjectEnvConfig, AzureDevOpsSyncStatus } from '../../../../shared/types';

interface AzureDevOpsIntegrationProps {
  projectId: string;
  envConfig: ProjectEnvConfig | null;
  updateEnvConfig: (updates: Partial<ProjectEnvConfig>) => void;
  showAzureDevOpsPat: boolean;
  setShowAzureDevOpsPat: React.Dispatch<React.SetStateAction<boolean>>;
  azureDevOpsConnectionStatus: AzureDevOpsSyncStatus | null;
  isCheckingAzureDevOps: boolean;
}

/**
 * Azure DevOps integration settings: organization, project, repository, PAT and connection status.
 */
export function AzureDevOpsIntegration({
  projectId,
  envConfig,
  updateEnvConfig,
  showAzureDevOpsPat,
  setShowAzureDevOpsPat,
  azureDevOpsConnectionStatus,
  isCheckingAzureDevOps
}: AzureDevOpsIntegrationProps) {
  const { t } = useTranslation('azuredevops');
  const [isDetecting, setIsDetecting] = useState(false);
  const [detectMessage, setDetectMessage] = useState<{ ok: boolean; text: string } | null>(null);

  if (!envConfig) return null;

  const handleDetect = async () => {
    setIsDetecting(true);
    setDetectMessage(null);
    try {
      const result = await window.electronAPI.detectAzureDevOpsRepository(projectId);
      if (result.success && result.data) {
        updateEnvConfig({
          azureDevOpsOrganization: result.data.organization,
          azureDevOpsProject: result.data.project,
          azureDevOpsRepository: result.data.repository
        });
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
          checked={envConfig.azureDevOpsEnabled}
          onCheckedChange={(checked) => updateEnvConfig({ azureDevOpsEnabled: checked })}
        />
      </div>

      {envConfig.azureDevOpsEnabled && (
        <>
          <Separator />

          <div className="space-y-2">
            <Label className="text-sm font-medium text-foreground">{t('organization.label')}</Label>
            <p className="text-xs text-muted-foreground">{t('organization.description')}</p>
            <Input
              placeholder={t('organization.placeholder')}
              value={envConfig.azureDevOpsOrganization || ''}
              onChange={(e) => updateEnvConfig({ azureDevOpsOrganization: e.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium text-foreground">{t('project.label')}</Label>
            <p className="text-xs text-muted-foreground">{t('project.description')}</p>
            <Input
              placeholder={t('project.placeholder')}
              value={envConfig.azureDevOpsProject || ''}
              onChange={(e) => updateEnvConfig({ azureDevOpsProject: e.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium text-foreground">{t('pat.label')}</Label>
            <p className="text-xs text-muted-foreground">{t('pat.description')}</p>
            <div className="relative">
              <Input
                type={showAzureDevOpsPat ? 'text' : 'password'}
                placeholder={t('pat.placeholder')}
                value={envConfig.azureDevOpsPat || ''}
                onChange={(e) => updateEnvConfig({ azureDevOpsPat: e.target.value })}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowAzureDevOpsPat((prev) => !prev)}
                aria-label={showAzureDevOpsPat ? t('pat.hide') : t('pat.show')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showAzureDevOpsPat ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium text-foreground">{t('repository.label')}</Label>
            <p className="text-xs text-muted-foreground">{t('repository.description')}</p>
            <div className="flex gap-2">
              <Input
                placeholder={t('repository.placeholder')}
                value={envConfig.azureDevOpsRepository || ''}
                onChange={(e) => updateEnvConfig({ azureDevOpsRepository: e.target.value })}
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
                {isCheckingAzureDevOps
                  ? t('connection.checking')
                  : azureDevOpsConnectionStatus === null
                    ? t('connection.notChecked')
                    : azureDevOpsConnectionStatus.connected
                      ? azureDevOpsConnectionStatus.repoFullName
                        ? t('connection.connected', { repo: azureDevOpsConnectionStatus.repoFullName })
                        : t('connection.connectedGeneric')
                      : azureDevOpsConnectionStatus.error || t('connection.failed')}
              </p>
            </div>
            {isCheckingAzureDevOps ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : azureDevOpsConnectionStatus?.connected ? (
              <CheckCircle2 className="h-4 w-4 text-success" />
            ) : azureDevOpsConnectionStatus ? (
              <AlertCircle className="h-4 w-4 text-destructive" />
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
