/**
 * zeenha fork: shows the failing CI checks and unresolved review feedback of a
 * task's pull request and lets the user choose which items to send to the
 * task's agent. Nothing is pre-selected and nothing starts without a click.
 * All GitHub text is rendered as plain text.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, GitPullRequest, Loader2, RefreshCw, Send } from 'lucide-react';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { usePRFeedback } from './hooks/usePRFeedback';
import type { PRFeedbackItem, Task } from '../../../shared/types';

interface PRFeedbackPanelProps {
  task: Task;
}

const FOLLOW_UP_PREFIX = '[PR follow-up]';

export function PRFeedbackPanel({ task }: PRFeedbackPanelProps) {
  const { t } = useTranslation(['tasks']);
  const eligible = Boolean(task.metadata?.prUrl) && (task.status === 'pr_created' || task.status === 'done');
  const { feedback, loading, error, refresh } = usePRFeedback(task.id, eligible);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);

  if (!eligible) return null;

  const outcomeLine = [...(task.logs ?? [])].reverse().find((l) => l.includes(FOLLOW_UP_PREFIX));

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const send = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setSending(true);
    setSendError(null);
    try {
      const result = await window.electronAPI.startPRFollowUp(task.id, ids);
      if (!result.success) {
        setSendError(result.error || t('tasks:prFeedback.sendFailed'));
      } else {
        setStarted(true);
        setSelected(new Set());
      }
    } catch (err) {
      setSendError(err instanceof Error ? err.message : t('tasks:prFeedback.sendFailed'));
    } finally {
      setSending(false);
    }
  };

  const renderItem = (item: PRFeedbackItem) => (
    <li key={item.id} className="flex items-start gap-2 rounded-lg border border-border bg-background/50 p-2">
      <Checkbox
        checked={selected.has(item.id)}
        onCheckedChange={() => toggle(item.id)}
        disabled={!feedback?.canStartFollowUp}
        aria-label={item.title}
        data-testid={`pr-feedback-item-${item.id}`}
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground break-words">{item.title}</div>
        {item.path && (
          <div className="text-xs text-muted-foreground break-all">
            {item.path}
            {item.line ? `:${item.line}` : ''}
          </div>
        )}
        {item.summary && (
          <p className="text-sm text-muted-foreground whitespace-pre-wrap break-words">{item.summary}</p>
        )}
        {item.author && <div className="text-xs text-muted-foreground">{item.author}</div>}
      </div>
      {item.url && (
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 shrink-0"
          onClick={() => window.electronAPI.openExternal(item.url as string)}
          aria-label={t('tasks:prFeedback.open')}
        >
          <ExternalLink className="h-3 w-3" />
        </Button>
      )}
    </li>
  );

  const renderGroup = (key: string, items: PRFeedbackItem[]) =>
    items.length > 0 && (
      <div data-testid={`pr-feedback-group-${key}`}>
        <div className="text-xs font-medium text-muted-foreground mb-1">{t(`tasks:prFeedback.${key}`)}</div>
        <ul className="space-y-2">{items.map(renderItem)}</ul>
      </div>
    );

  const blocked = feedback?.blockedReason;
  const total = feedback ? feedback.checks.length + feedback.threads.length + feedback.reviews.length : 0;

  return (
    <div className="rounded-xl border border-border bg-muted/30 p-4" data-testid="pr-feedback-panel">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-medium text-sm text-foreground flex items-center gap-2">
          <GitPullRequest className="h-4 w-4" />
          {t('tasks:prFeedback.title')}
        </h3>
        <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={loading} data-testid="pr-feedback-refresh">
          {loading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />}
          {t('tasks:prFeedback.refresh')}
        </Button>
      </div>

      {error && (
        <p className="text-sm text-destructive break-words" data-testid="pr-feedback-error">
          {t('tasks:prFeedback.loadFailed', { error })}
        </p>
      )}

      {feedback && (
        <div className="space-y-3">
          {blocked && (
            <p className="text-sm text-muted-foreground" data-testid="pr-feedback-blocked">
              {t(`tasks:prFeedback.blocked.${blocked}`)}
            </p>
          )}
          {total === 0 && !blocked && (
            <p className="text-sm text-muted-foreground">{t('tasks:prFeedback.empty')}</p>
          )}
          {renderGroup('failedChecks', feedback.checks)}
          {renderGroup('unresolvedComments', feedback.threads)}
          {renderGroup('changeRequests', feedback.reviews)}

          {feedback.canStartFollowUp && (
            <Button
              size="sm"
              className="w-full"
              onClick={() => void send()}
              disabled={selected.size === 0 || sending}
              data-testid="pr-feedback-send"
            >
              {sending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
              {t('tasks:prFeedback.send')}
            </Button>
          )}
        </div>
      )}

      {sendError && (
        <p className="mt-2 text-sm text-destructive break-words" data-testid="pr-feedback-send-error">
          {sendError}
        </p>
      )}
      {(started || outcomeLine) && (
        <p className="mt-2 text-sm text-muted-foreground break-words" data-testid="pr-feedback-status">
          {outcomeLine ?? t('tasks:prFeedback.started')}
        </p>
      )}
    </div>
  );
}
