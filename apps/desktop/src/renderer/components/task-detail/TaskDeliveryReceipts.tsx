import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeliveryReceipt } from '../../../shared/types/delivery-receipt';
import type { Task } from '../../../shared/types';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';

type ReceiptScope = Pick<Task, 'projectId' | 'specId'>;

type History =
  | { state: 'loading' | 'error' }
  | { state: 'loaded'; receipts: DeliveryReceipt[] };

const statusVariants = {
  delivered: 'success',
  skipped: 'secondary',
  failed: 'destructive',
  unknown: 'warning',
} as const;

// zeenha fork: read-only delivery evidence, independent of the build result.
export function TaskDeliveryReceipts({ task, open }: { task: ReceiptScope; open: boolean }) {
  if (!open) return null;
  const { projectId, specId } = task;
  // Reset history before painting a different task (even if it has the same spec ID).
  return <DeliveryHistory key={JSON.stringify([projectId, specId])} projectId={projectId} specId={specId} />;
}

function DeliveryHistory({ projectId, specId }: ReceiptScope) {
  const { t, i18n } = useTranslation('tasks');
  const titleId = useId();
  const [history, setHistory] = useState<History>({ state: 'loading' });
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const result = await window.electronAPI.getTaskDeliveryReceipts?.(projectId, specId);
        if (cancelled) return;
        if (!result?.success) {
          setHistory({ state: 'error' });
        } else {
          const receipts = [...(result.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          setHistory({ state: 'loaded', receipts });
        }
      } catch {
        if (!cancelled) setHistory({ state: 'error' });
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [projectId, specId, revision]);

  const formatDate = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <section aria-labelledby={titleId} className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 id={titleId} className="text-sm font-semibold">{t('tasks:deliveryHistory.title')}</h3>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={history.state === 'loading'}
          onClick={() => {
            setHistory({ state: 'loading' });
            setRevision((value) => value + 1);
          }}
        >
          {t('tasks:deliveryHistory.refresh')}
        </Button>
      </div>
      {history.state === 'loading' && <p role="status" className="text-sm text-muted-foreground">{t('tasks:deliveryHistory.loading')}</p>}
      {history.state === 'error' && <p role="alert" className="text-sm text-destructive">{t('tasks:deliveryHistory.error')}</p>}
      {history.state === 'loaded' && (
        history.receipts.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">{t('tasks:deliveryHistory.empty')}</p>
        ) : (
          <>
            {history.receipts.some((receipt) => receipt.status === 'unknown') && (
              <p className="text-sm text-muted-foreground">{t('tasks:deliveryHistory.unknownHint')}</p>
            )}
            <ul className="divide-y divide-border rounded-md border border-border">
              {history.receipts.map((receipt) => (
                <li key={receipt.id} className="space-y-1 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                    <span className="font-medium">{t(`tasks:deliveryHistory.operations.${receipt.operation}`)}</span>
                    {receipt.provider && <span>{t(`tasks:deliveryHistory.providers.${receipt.provider}`)}</span>}
                    <Badge variant={statusVariants[receipt.status]}>{t(`tasks:deliveryHistory.statuses.${receipt.status}`)}</Badge>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{t(`tasks:deliveryHistory.events.${receipt.event}`)}</span>
                    <time dateTime={receipt.createdAt}>{formatDate.format(new Date(receipt.createdAt))}</time>
                  </div>
                  {receipt.reason && (
                    <p className="text-xs text-muted-foreground">{t(`tasks:deliveryHistory.reasons.${receipt.reason}`)}</p>
                  )}
                </li>
              ))}
            </ul>
          </>
        )
      )}
    </section>
  );
}
