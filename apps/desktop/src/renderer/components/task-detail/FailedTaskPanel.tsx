/**
 * zeenha fork: detail-view panel for a task in the Failed column (status
 * 'error': its run failed before doing any work). Shows why, and the two
 * fixes: Retry (continue from where it stopped) and Re-plan (discard the plan
 * and plan again; only offered when there is a plan to discard).
 *
 * There is deliberately no Create PR here: a task that did no work has
 * nothing to put in one.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ListRestart, Loader2, RotateCcw } from 'lucide-react';
import { Button } from '../ui/button';
import { replanFailedTask, retryFailedTask } from '../../stores/task-store';
import type { Task } from '../../../shared/types';

interface FailedTaskPanelProps {
  task: Task;
}

export function FailedTaskPanel({ task }: FailedTaskPanelProps) {
  const { t } = useTranslation(['tasks']);
  const [busy, setBusy] = useState<'retry' | 'replan' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const hasPlan = task.subtasks.length > 0;

  const run = async (kind: 'retry' | 'replan') => {
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      const result = kind === 'retry' ? await retryFailedTask(task.id) : await replanFailedTask(task.id);
      if (!result.success) {
        setError(result.error || t('tasks:wizard.errors.startFailed'));
      } else if (result.action === 'queued') {
        setNotice(t('tasks:queue.movedToQueue'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('tasks:wizard.errors.startFailed'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4" data-testid="failed-task-panel">
      <h3 className="font-medium text-sm text-foreground mb-2 flex items-center gap-2">
        <AlertCircle className="h-4 w-4 text-destructive" />
        {t('tasks:failedTask.title')}
      </h3>
      <p className="text-sm text-muted-foreground mb-3">{t('tasks:failedTask.description')}</p>

      <div className="mb-4 rounded-lg border border-border bg-background/50 p-3">
        <div className="text-xs font-medium text-muted-foreground mb-1">{t('tasks:failedTask.reason')}</div>
        <p className="text-sm text-foreground whitespace-pre-wrap break-words" data-testid="failed-task-reason">
          {task.failureReason || t('tasks:failedTask.noReason')}
        </p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          size="sm"
          variant="default"
          className="flex-1"
          onClick={() => run('retry')}
          disabled={busy !== null}
          title={t('tasks:failedTask.retryHint')}
          data-testid="failed-task-retry"
        >
          {busy === 'retry' ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RotateCcw className="h-4 w-4 mr-2" />}
          {busy === 'retry' ? t('tasks:failedTask.starting') : t('tasks:failedTask.retry')}
        </Button>
        {hasPlan && (
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            onClick={() => run('replan')}
            disabled={busy !== null}
            title={t('tasks:failedTask.replanHint')}
            data-testid="failed-task-replan"
          >
            {busy === 'replan' ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <ListRestart className="h-4 w-4 mr-2" />}
            {busy === 'replan' ? t('tasks:failedTask.starting') : t('tasks:failedTask.replan')}
          </Button>
        )}
      </div>

      {error && <p className="text-xs text-destructive mt-2">{error}</p>}
      {notice && <p className="text-xs text-muted-foreground mt-2">{notice}</p>}
    </div>
  );
}
