// zeenha fork: board banner shown while the queue waits for account capacity
// (every usable account is rate limited, or a task just paused for an account).
import { Hourglass } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface QueueCapacityBannerProps {
  /** ms timestamp until which the queue starts no task */
  until: number;
  /** true when `until` is a backoff guess rather than a known reset time */
  estimated?: boolean;
}

function formatUntil(until: number, locale: string): string {
  const date = new Date(until);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function QueueCapacityBanner({ until, estimated }: QueueCapacityBannerProps) {
  const { t, i18n } = useTranslation('tasks');

  return (
    <div
      role="status"
      data-testid="queue-capacity-banner"
      className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm"
    >
      <Hourglass className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
      <p className="min-w-0 flex-1 font-medium text-foreground">
        {estimated
          ? t('kanban.capacityWait.retryingSoon')
          : t('kanban.capacityWait.until', { time: formatUntil(until, i18n.language) })}
      </p>
    </div>
  );
}
