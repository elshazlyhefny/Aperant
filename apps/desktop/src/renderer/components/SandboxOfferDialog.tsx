import { useTranslation } from 'react-i18next';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog';
import type { BashSandboxMode, Project, SandboxAvailability } from '../../shared/types';

interface SandboxOfferDialogProps {
  open: boolean;
  project: Project;
  availability: SandboxAvailability;
  onEnable: (mode: Exclude<BashSandboxMode, 'off'>) => void;
  onSkip: () => void;
}

/**
 * zeenha fork: offered once after a project is added, only when the OS sandbox
 * tool is installed. Choosing "Not now" leaves the sandbox off.
 */
export function SandboxOfferDialog({ open, project, availability, onEnable, onSkip }: SandboxOfferDialogProps) {
  const { t } = useTranslation('dialogs');
  // zeenha fork: offer only the modes this platform can enforce. 'restricted-rights'
  // is Windows only, so it also requires the Windows launcher (PowerShell).
  const offered = (mode: Exclude<BashSandboxMode, 'off'>) =>
    !availability.unsupportedModes?.includes(mode) &&
    (mode !== 'restricted-rights' || availability.tool === 'powershell');

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onSkip(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('sandboxOffer.title')}</DialogTitle>
          <DialogDescription>
            {t('sandboxOffer.description', { projectName: project.name, tool: availability.tool ?? '' })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {offered('home-hidden') && (
            <div>
              <p className="font-medium">{t('sandboxOffer.homeHidden.label')}</p>
              <p className="text-muted-foreground">{t('sandboxOffer.homeHidden.description')}</p>
            </div>
          )}
          {offered('home-hidden-no-network') && (
            <div>
              <p className="font-medium">{t('sandboxOffer.homeHiddenNoNetwork.label')}</p>
              <p className="text-muted-foreground">{t('sandboxOffer.homeHiddenNoNetwork.description')}</p>
            </div>
          )}
          {offered('restricted-rights') && (
            <div>
              <p className="font-medium">{t('sandboxOffer.restrictedRights.label')}</p>
              <p className="text-muted-foreground">{t('sandboxOffer.restrictedRights.description')}</p>
            </div>
          )}
          <p className="text-muted-foreground">{t('sandboxOffer.failClosed')}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onSkip}>
            {t('sandboxOffer.skip')}
          </Button>
          {offered('home-hidden-no-network') && (
            <Button variant="secondary" onClick={() => onEnable('home-hidden-no-network')}>
              {t('sandboxOffer.homeHiddenNoNetwork.label')}
            </Button>
          )}
          {offered('home-hidden') && (
            <Button onClick={() => onEnable('home-hidden')}>
              {t('sandboxOffer.homeHidden.label')}
            </Button>
          )}
          {offered('restricted-rights') && (
            <Button onClick={() => onEnable('restricted-rights')}>
              {t('sandboxOffer.restrictedRights.label')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
