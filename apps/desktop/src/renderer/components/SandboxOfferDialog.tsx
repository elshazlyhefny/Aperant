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
  // zeenha fork: do not offer a mode this platform refuses (Windows cannot block the network).
  const offerNoNetwork = !availability.unsupportedModes?.includes('home-hidden-no-network');

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
          <div>
            <p className="font-medium">{t('sandboxOffer.homeHidden.label')}</p>
            <p className="text-muted-foreground">{t('sandboxOffer.homeHidden.description')}</p>
          </div>
          {offerNoNetwork && (
            <div>
              <p className="font-medium">{t('sandboxOffer.homeHiddenNoNetwork.label')}</p>
              <p className="text-muted-foreground">{t('sandboxOffer.homeHiddenNoNetwork.description')}</p>
            </div>
          )}
          <p className="text-muted-foreground">{t('sandboxOffer.failClosed')}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onSkip}>
            {t('sandboxOffer.skip')}
          </Button>
          {offerNoNetwork && (
            <Button variant="secondary" onClick={() => onEnable('home-hidden-no-network')}>
              {t('sandboxOffer.homeHiddenNoNetwork.label')}
            </Button>
          )}
          <Button onClick={() => onEnable('home-hidden')}>
            {t('sandboxOffer.homeHidden.label')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
