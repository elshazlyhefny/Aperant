/**
 * zeenha fork: shows the failing CI checks and unresolved review feedback of a
 * task's pull request and lets the user choose which items to send to the
 * task's agent. Selections are bound to the displayed PR revision. Nothing is
 * pre-selected and nothing starts without a click. Works for GitHub, GitLab,
 * Bitbucket Cloud and Azure DevOps. All forge text is rendered as plain text.
 */
import { useEffect, useState } from 'react';
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
  const headSha = feedback?.headSha;
  const [selection, setSelection] = useState(() => ({ headSha, ids: new Set<string>() }));
  const selected = selection.headSha === headSha ? selection.ids : undefined;
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [stale, setStale] = useState<'head_changed' | 'head_unverified' | null>(null);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    setSelection({ headSha, ids: new Set() });
  }, [headSha]);

  if (!eligible) return null;

  const outcomeLine = [...(task.logs ?? [])].reverse().find((l) => l.includes(FOLLOW_UP_PREFIX));

  const canSelect = feedback?.canStartFollowUp && !loading && !stale && !sending;

  const refreshFeedback = () => {
    setStale(null);
    void refresh();
  };

  const toggle = (id: string) => {
    setSelection((prev) => {
      const next = new Set(prev.headSha === headSha ? prev.ids : undefined);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { headSha, ids: next };
    });
  };

  const send = async () => {
    if (!feedback || !canSelect || !selected?.size) return;
    const ids = Array.from(selected);
    setSending(true);
    setSendError(null);
    try {
      const result = await window.electronAPI.startPRFollowUp(task.id, ids, feedback.headSha);
      if (!result.success) {
        const code = 'code' in result ? result.code : undefined;
        if (code === 'head_changed' || code === 'head_unverified') {
          setSelection({ headSha, ids: new Set() });
          setStale(code);
        } else {
          setSendError(result.error || t('tasks:prFeedback.sendFailed'));
        }
      } else {
        setStarted(true);
        setSelection({ headSha, ids: new Set() });
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
        checked={selected?.has(item.id) ?? false}
        onCheckedChange={() => toggle(item.id)}
        disabled={!canSelect}
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
        <Button size="sm" variant="ghost" onClick={refreshFeedback} disabled={loading || sending} data-testid="pr-feedback-refresh">
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
          {headSha && (
            <p className="text-xs text-muted-foreground" data-testid="pr-feedback-revision">
              {t('tasks:prFeedback.revision', { sha: headSha.slice(0, 7) })}
            </p>
          )}
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
              disabled={!selected?.size || !canSelect}
              data-testid="pr-feedback-send"
            >
              {sending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
              {t('tasks:prFeedback.send')}
            </Button>
          )}
        </div>
      )}

      {stale && (
        <div className="mt-2 space-y-2" data-testid="pr-feedback-stale">
          <p className="text-sm text-muted-foreground" role="alert">
            {t(`tasks:prFeedback.stale.${stale}`)}
          </p>
          <Button size="sm" variant="outline" onClick={refreshFeedback} data-testid="pr-feedback-stale-refresh">
            {t('tasks:prFeedback.refresh')}
          </Button>
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
      {outcomeLine?.includes('Not pushed (stale)') && (
        <p className="mt-2 text-sm text-muted-foreground" data-testid="pr-feedback-stale-outcome">
          {t('tasks:prFeedback.staleOutcome')}
        </p>
      )}
    </div>
  );
}
