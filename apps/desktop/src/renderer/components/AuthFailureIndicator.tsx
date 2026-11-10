import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { useAuthFailureStore } from '../stores/auth-failure-store';

interface AuthFailureIndicatorProps {
  isCollapsed?: boolean;
}

/**
 * zeenha fork: sidebar indicator shown while an authentication failure is
 * unresolved. Clicking it reopens the auth failure modal.
 */
export function AuthFailureIndicator({ isCollapsed = false }: AuthFailureIndicatorProps) {
  const { t } = useTranslation('common');
  const hasPendingAuthFailure = useAuthFailureStore((s) => s.hasPendingAuthFailure);
  const authFailureInfo = useAuthFailureStore((s) => s.authFailureInfo);
  const reopenAuthFailureModal = useAuthFailureStore((s) => s.reopenAuthFailureModal);

  if (!hasPendingAuthFailure) {
    return null;
  }

  const profile = authFailureInfo?.profileName || t('auth.failure.unknownProfile');
  const ariaLabel = t('auth.failure.indicator.ariaLabel', { profile });

  if (isCollapsed) {
    return (
      <div className="mx-3 mb-3 flex justify-center">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={ariaLabel}
              onClick={reopenAuthFailureModal}
              className="relative flex h-9 w-9 items-center justify-center rounded-lg border border-warning/50 bg-warning/10 hover:bg-warning/20 transition-colors"
            >
              <AlertTriangle className="h-4 w-4 text-warning" aria-hidden="true" />
              <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-destructive" aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{ariaLabel}</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="mx-3 mb-3">
      <button
        type="button"
        aria-label={ariaLabel}
        onClick={reopenAuthFailureModal}
        className="flex w-full items-start gap-2 rounded-lg border border-warning/50 bg-warning/10 p-3 text-left hover:bg-warning/20 transition-colors"
      >
        <AlertTriangle className="h-4 w-4 text-warning mt-0.5 shrink-0" aria-hidden="true" />
        <span className="flex-1 min-w-0">
          <span className="block text-xs font-medium text-warning">
            {t('auth.failure.indicator.title')}
          </span>
          <span className="block text-xs text-muted-foreground mt-0.5 truncate">{profile}</span>
          <span className="block text-xs text-primary mt-1">
            {t('auth.failure.indicator.clickToFix')}
          </span>
        </span>
      </button>
    </div>
  );
}
