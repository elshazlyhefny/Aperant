import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { PauseCircle } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { useProjectStore } from '../../stores/project-store';
import { persistUpdateTask, startTaskOrQueue } from '../../stores/task-store';
import { formatTokens } from './usage-format';
import { budgetTokens, resolveTokenBudget } from '../../../shared/utils/token-budget';
import type { Task } from '../../../shared/types';

interface TokenBudgetBannerProps {
  task: Task;
}

/** zeenha fork: suggested raised limit is the current limit plus 50%, rounded. */
export function suggestRaisedBudget(limit: number): number {
  return Math.round(limit * 1.5);
}

/**
 * zeenha fork: shown when a task paused because it reached its token budget.
 * Lets the user raise (or remove) the limit and resume.
 */
export function TokenBudgetBanner({ task }: TokenBudgetBannerProps) {
  const { t, i18n } = useTranslation(['tasks']);
  const activeProject = useProjectStore((s) => s.getActiveProject());
  const projectId = activeProject?.id;
  const limit = resolveTokenBudget(task.metadata, activeProject?.settings);

  const [used, setUsed] = useState<number | null>(null);
  const [value, setValue] = useState<string>(limit ? String(suggestRaisedBudget(limit)) : '');
  const [unlimited, setUnlimited] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    window.electronAPI
      .getTaskRunMetrics(projectId, task.specId)
      .then((result) => {
        if (!cancelled && result.success && result.data) {
          setUsed(budgetTokens(result.data.summary.tokens));
        }
      })
      .catch(() => {
        // Usage is informational here; the banner still works without it.
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, task.specId]);

  const fmt = (n: number) => formatTokens(n, i18n.language);
  const parsed = Number(value);
  const hasValidValue = Number.isFinite(parsed) && Math.floor(parsed) > 0;
  const canResume = !isResuming && (unlimited || hasValidValue);

  const handleResume = async () => {
    setIsResuming(true);
    setError(null);
    const tokenBudget = unlimited ? 0 : Math.floor(parsed);
    const saved = await persistUpdateTask(task.id, { metadata: { tokenBudget } });
    if (!saved) {
      setError(t('tasks:tokenBudgetBanner.saveFailed'));
      setIsResuming(false);
      return;
    }
    const result = await startTaskOrQueue(task.id);
    if (!result.success) {
      setError(result.error ?? t('tasks:wizard.errors.startFailed'));
    }
    setIsResuming(false);
  };

  return (
    <div
      className="rounded-md border border-warning/40 bg-warning/10 p-3 space-y-2"
      data-testid="token-budget-banner"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <PauseCircle className="h-4 w-4" />
        {t('tasks:tokenBudgetBanner.title')}
      </div>
      {limit !== undefined && (
        <p className="text-sm" data-testid="token-budget-banner-usage">
          {t('tasks:tokenBudgetBanner.usage', {
            used: used === null ? '?' : fmt(used),
            limit: fmt(limit)
          })}
        </p>
      )}
      <p className="text-xs text-muted-foreground">{t('tasks:tokenBudgetBanner.body')}</p>
      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-xs text-muted-foreground" htmlFor="token-budget-banner-input">
          {t('tasks:tokenBudgetBanner.fieldLabel')}
        </label>
        <Input
          id="token-budget-banner-input"
          type="number"
          min={1}
          className="w-40 h-8"
          value={value}
          disabled={unlimited}
          onChange={(e) => setValue(e.target.value)}
          data-testid="token-budget-banner-input"
        />
        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={unlimited}
            onChange={(e) => setUnlimited(e.target.checked)}
            data-testid="token-budget-banner-unlimited"
          />
          {t('tasks:tokenBudgetBanner.unlimited')}
        </label>
        <Button size="sm" onClick={handleResume} disabled={!canResume} data-testid="token-budget-banner-resume">
          {t('tasks:tokenBudgetBanner.resume')}
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
