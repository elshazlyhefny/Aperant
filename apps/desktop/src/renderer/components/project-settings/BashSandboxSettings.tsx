import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ShieldCheck } from 'lucide-react';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { deriveSandboxStatus } from '../../../shared/utils/sandbox-status';
import type {
  BashSandboxMode,
  ProjectSettings,
  SandboxAvailability,
  SandboxStatusKind
} from '../../../shared/types';

/**
 * zeenha fork: per-project Bash sandbox control with its availability.
 * Existing stored bashSandbox values keep working; a missing value means off.
 * When the tool cannot run, a non-off mode is allowed but warned about,
 * because sandbox.ts fails closed and refuses every agent shell command.
 */

interface BashSandboxSettingsProps {
  settings: ProjectSettings;
  setSettings: React.Dispatch<React.SetStateAction<ProjectSettings>>;
}

type StatusKey = SandboxStatusKind | 'checking';
type SandboxModeOption = Exclude<BashSandboxMode, 'off'>;

const MODE_OPTIONS: { value: SandboxModeOption; labelKey: string; explanationKey: string; platformSpecific: boolean }[] = [
  {
    value: 'home-hidden',
    labelKey: 'projectSections.security.mode.homeHidden',
    explanationKey: 'projectSections.security.mode.homeHiddenExplanation',
    platformSpecific: false
  },
  {
    value: 'home-hidden-no-network',
    labelKey: 'projectSections.security.mode.homeHiddenNoNetwork',
    explanationKey: 'projectSections.security.mode.homeHiddenNoNetworkExplanation',
    platformSpecific: false
  },
  {
    value: 'restricted-rights',
    labelKey: 'projectSections.security.mode.restrictedRights',
    explanationKey: 'projectSections.security.mode.restrictedRightsExplanation',
    platformSpecific: true
  }
];

const STATUS_BADGE: Record<StatusKey, string> = {
  active: 'bg-success/10 text-success',
  'available-off': 'bg-warning/10 text-warning',
  'tool-missing': 'bg-destructive/10 text-destructive',
  unsupported: 'bg-muted text-muted-foreground',
  'mode-unsupported': 'bg-destructive/10 text-destructive',
  checking: 'bg-muted text-muted-foreground'
};

export function BashSandboxSettings({ settings, setSettings }: BashSandboxSettingsProps) {
  const { t } = useTranslation('settings');
  // undefined while checking; null when the check failed
  const [availability, setAvailability] = useState<SandboxAvailability | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.getSandboxAvailability()
      .then((result) => {
        if (!cancelled) setAvailability(result.success && result.data ? result.data : null);
      })
      .catch(() => {
        if (!cancelled) setAvailability(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const mode: BashSandboxMode = settings?.bashSandbox ?? 'off';
  const status: StatusKey = availability ? deriveSandboxStatus(availability, mode) : 'checking';
  const cannotRun =
    availability?.state === 'tool-missing' ||
    availability?.state === 'unsupported' ||
    status === 'mode-unsupported';
  const toolName = availability?.tool ?? '';
  // zeenha fork: 'restricted-rights' is Windows only (it needs the PowerShell launcher);
  // until availability is known, only that mode is treated as unsupported.
  const isUnsupported = (m: SandboxModeOption): boolean =>
    (m === 'restricted-rights' && availability?.tool !== 'powershell') ||
    (availability?.unsupportedModes?.includes(m) ?? false);
  // An unsupported mode is shown disabled, except a platform-specific extra mode
  // (restricted-rights off Windows), which is not offered unless it is saved.
  const visibleModes = MODE_OPTIONS.filter(
    (o) => !(isUnsupported(o.value) && o.platformSpecific && mode !== o.value)
  );

  const installHintKey =
    status === 'tool-missing'
      ? availability?.tool === 'bwrap'
        ? 'projectSections.security.installHint.linux'
        : availability?.tool === 'sandbox-exec'
          ? 'projectSections.security.installHint.macos'
          : null
      : null;

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <ShieldCheck className="h-4 w-4" />
        {t('projectSections.security.mode.label')}
        <span className={`px-2 py-0.5 text-xs rounded-full ${STATUS_BADGE[status]}`}>
          {t(`projectSections.security.status.${status}`)}
        </span>
      </div>

      <div className="space-y-4 pl-6">
        {status !== 'checking' && (
          <p className="text-xs text-muted-foreground">
            {t(`projectSections.security.statusDetail.${status}`, { tool: toolName })}
          </p>
        )}

        {installHintKey && (
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <p className="text-xs text-muted-foreground">{t(installHintKey)}</p>
          </div>
        )}

        <div className="space-y-2">
          <Label className="font-normal text-foreground">
            {t('projectSections.security.mode.description')}
          </Label>
          <Select
            value={mode}
            onValueChange={(value) => setSettings((prev) => ({ ...prev, bashSandbox: value as BashSandboxMode }))}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">{t('projectSections.security.mode.off')}</SelectItem>
              {visibleModes.map((o) => (
                <SelectItem key={o.value} value={o.value} disabled={isUnsupported(o.value) && mode !== o.value}>
                  {isUnsupported(o.value)
                    ? t('projectSections.security.mode.notSupported', { mode: t(o.labelKey) })
                    : t(o.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {cannotRun && mode !== 'off' && (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3">
            <AlertTriangle className="h-4 w-4 mt-0.5 text-destructive shrink-0" />
            <p className="text-xs text-destructive">{t('projectSections.security.refusedWarning')}</p>
          </div>
        )}

        <ul className="rounded-lg border border-border bg-muted/30 p-3 space-y-1 text-xs text-muted-foreground">
          <li>{t('projectSections.security.mode.offExplanation')}</li>
          {visibleModes
            .filter((o) => !isUnsupported(o.value) || mode === o.value)
            .map((o) => (
              <li key={o.value}>{t(o.explanationKey)}</li>
            ))}
        </ul>

        {availability?.tool === 'powershell' && (
          <p className="text-xs text-muted-foreground">{t('projectSections.security.windowsNote')}</p>
        )}
      </div>
    </section>
  );
}
