import { useTranslation } from 'react-i18next';
import { Globe } from 'lucide-react';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import type { ProjectSettings, WebFetchProviderMode } from '../../../shared/types';

/**
 * zeenha fork: per-project WebFetch provider. A missing value means 'jina'.
 * The Jina note is always shown because Jina Reader sees every fetched URL.
 */

interface WebFetchSettingsProps {
  settings: ProjectSettings;
  setSettings: React.Dispatch<React.SetStateAction<ProjectSettings>>;
}

export function WebFetchSettings({ settings, setSettings }: WebFetchSettingsProps) {
  const { t } = useTranslation('settings');
  const provider: WebFetchProviderMode = settings?.webFetchProvider ?? 'jina';

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Globe className="h-4 w-4" />
        {t('projectSections.security.webFetch.label')}
      </div>

      <div className="space-y-4 pl-6">
        <div className="space-y-2">
          <Label className="font-normal text-foreground">
            {t('projectSections.security.webFetch.description')}
          </Label>
          <Select
            value={provider}
            onValueChange={(value) =>
              setSettings((prev) => ({ ...prev, webFetchProvider: value as WebFetchProviderMode }))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="jina">{t('projectSections.security.webFetch.options.jina')}</SelectItem>
              <SelectItem value="direct">{t('projectSections.security.webFetch.options.direct')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <p className="text-xs text-muted-foreground">{t('projectSections.security.webFetch.jinaNote')}</p>
        <p className="text-xs text-muted-foreground">{t('projectSections.security.webFetch.directNote')}</p>

        {settings?.bashSandbox === 'home-hidden-no-network' && (
          <p className="text-xs text-muted-foreground">
            {t('projectSections.security.webFetch.disabledByNoNetwork')}
          </p>
        )}
      </div>
    </section>
  );
}
