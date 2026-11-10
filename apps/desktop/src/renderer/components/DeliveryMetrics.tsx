/**
 * zeenha fork: project-wide delivery and token metrics view.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, AlertCircle, RefreshCw, Activity } from 'lucide-react';
import { ScrollArea } from './ui/scroll-area';
import { Button } from './ui/button';
import { cn } from '../lib/utils';
import { formatDuration, formatTokens } from './task-detail/usage-format';
import type { ProjectRunMetrics, ProjectRunMetricsGroup } from '../../shared/types/run-metrics';

interface DeliveryMetricsProps {
  projectId: string;
}

type Period = 7 | 30 | 90 | null;

const PERIODS: Array<{ value: Period; key: string }> = [
  { value: 7, key: 'days7' },
  { value: 30, key: 'days30' },
  { value: 90, key: 'days90' },
  { value: null, key: 'all' }
];

const th = 'text-left font-medium text-muted-foreground px-2 py-1';
const td = 'px-2 py-1';

export function DeliveryMetrics({ projectId }: DeliveryMetricsProps) {
  const { t, i18n } = useTranslation(['tasks']);
  const [periodDays, setPeriodDays] = useState<Period>(30);
  const [metrics, setMetrics] = useState<ProjectRunMetrics | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setIsLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.getProjectRunMetrics(projectId, periodDays);
      if (id !== requestId.current) return;
      if (!result.success) {
        throw new Error(result.error || 'Failed to load delivery metrics');
      }
      setMetrics(result.data ?? null);
    } catch (err) {
      if (id !== requestId.current) return;
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      if (id === requestId.current) setIsLoading(false);
    }
  }, [projectId, periodDays]);

  useEffect(() => {
    load();
    return () => {
      // Invalidate in-flight requests on unmount or dependency change.
      requestId.current++;
    };
  }, [load]);

  const fmt = (n: number) => formatTokens(n, i18n.language);

  if (isLoading && !metrics) {
    return (
      <div className="h-full flex items-center justify-center" data-testid="delivery-loading">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">{t('tasks:delivery.loading')}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center" data-testid="delivery-error">
        <div className="text-center">
          <AlertCircle className="h-8 w-8 mx-auto mb-2 text-destructive" />
          <p className="text-sm text-destructive mb-2">{t('tasks:delivery.error')}</p>
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="h-3 w-3 mr-1" />
            {t('tasks:delivery.retry')}
          </Button>
        </div>
      </div>
    );
  }

  const periodSelector = (
    <div className="flex items-center gap-2">
      <label htmlFor="delivery-period" className="text-xs text-muted-foreground">
        {t('tasks:delivery.period.label')}
      </label>
      <select
        id="delivery-period"
        data-testid="delivery-period"
        className="h-8 rounded-md border border-border bg-background px-2 text-xs"
        value={periodDays === null ? 'all' : String(periodDays)}
        onChange={(e) => setPeriodDays(e.target.value === 'all' ? null : (Number(e.target.value) as Period))}
      >
        {PERIODS.map((p) => (
          <option key={p.key} value={p.value === null ? 'all' : String(p.value)}>
            {t(`tasks:delivery.period.${p.key}`)}
          </option>
        ))}
      </select>
      <Button variant="ghost" size="sm" onClick={load} disabled={isLoading} aria-label={t('tasks:delivery.refresh')}>
        <RefreshCw className={cn('h-3 w-3 mr-1', isLoading && 'animate-spin')} />
        {t('tasks:delivery.refresh')}
      </Button>
    </div>
  );

  const header = (
    <div className="flex items-center justify-between">
      <h2 className="text-sm font-semibold">{t('tasks:delivery.title')}</h2>
      {periodSelector}
    </div>
  );

  if (!metrics || (metrics.completedTasks === 0 && metrics.included === 0)) {
    return (
      <div className="h-full p-4 space-y-6" data-testid="delivery-metrics">
        {header}
        <div className="flex items-center justify-center" data-testid="delivery-empty">
          <div className="text-center py-12">
            <Activity className="h-10 w-10 mx-auto mb-3 text-muted-foreground/30" />
            <p className="text-sm font-medium text-muted-foreground mb-1">{t('tasks:delivery.empty')}</p>
            <p className="text-xs text-muted-foreground">{t('tasks:delivery.emptyHint')}</p>
          </div>
        </div>
      </div>
    );
  }

  const failed = metrics.failedBeforeWork.count;
  const cards: Array<{ id: string; label: string; value: string; highlight?: boolean }> = [
    { id: 'tasks-scanned', label: t('tasks:delivery.cards.tasksScanned'), value: fmt(metrics.taskCount) },
    { id: 'completed', label: t('tasks:delivery.cards.completedTasks'), value: fmt(metrics.completedTasks) },
    { id: 'total-tokens', label: t('tasks:delivery.cards.totalTokens'), value: fmt(metrics.totals.totalTokens) },
    {
      id: 'total-duration',
      label: t('tasks:delivery.cards.totalDuration'),
      value: formatDuration(metrics.totals.durationMs)
    },
    {
      id: 'avg-tokens',
      label: t('tasks:delivery.cards.avgTokens'),
      value: metrics.perCompletedTask ? fmt(Math.round(metrics.perCompletedTask.totalTokens)) : '—'
    },
    {
      id: 'avg-duration',
      label: t('tasks:delivery.cards.avgDuration'),
      value: metrics.perCompletedTask ? formatDuration(metrics.perCompletedTask.durationMs) : '—'
    },
    {
      id: 'failed-before-work',
      label: t('tasks:delivery.cards.failedBeforeWork'),
      value: fmt(failed),
      highlight: failed > 0
    },
    {
      id: 'avg-qa',
      label: t('tasks:delivery.cards.avgQa'),
      value:
        metrics.qa.averageIterations === null
          ? '—'
          : new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(metrics.qa.averageIterations)
    }
  ];

  const missingOrCorrupt = metrics.excluded.missing + metrics.excluded.corrupt;
  const maxTrend = Math.max(0, ...metrics.trend.map((p) => p.tokensPerCompletedTask ?? 0));

  const renderGroups = (title: string, firstColumn: string, groups: ProjectRunMetricsGroup[], testId: string) => (
    <section data-testid={testId}>
      <h3 className="text-sm font-semibold mb-2">{title}</h3>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border">
            <th className={th}>{firstColumn}</th>
            <th className={th}>{t('tasks:delivery.columns.sessions')}</th>
            <th className={th}>{t('tasks:delivery.columns.duration')}</th>
            <th className={th}>{t('tasks:delivery.columns.input')}</th>
            <th className={th}>{t('tasks:delivery.columns.output')}</th>
            <th className={th}>{t('tasks:delivery.columns.total')}</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.key} className="border-b border-border/50">
              <td className={td}>{g.key}</td>
              <td className={td}>{fmt(g.sessions)}</td>
              <td className={td}>{formatDuration(g.durationMs)}</td>
              <td className={td}>{fmt(g.tokens.input)}</td>
              <td className={td}>{fmt(g.tokens.output)}</td>
              <td className={td}>{fmt(g.totalTokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );

  return (
    <ScrollArea className="h-full">
      <div className="p-4 space-y-6" data-testid="delivery-metrics">
        {header}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3" data-testid="delivery-cards">
          {cards.map((c) => (
            <div
              key={c.id}
              className={cn('rounded-md border border-border p-3', c.highlight && 'border-destructive')}
              data-testid={`delivery-card-${c.id}`}
            >
              <div className="text-xs text-muted-foreground">{c.label}</div>
              <div className={cn('text-lg font-semibold', c.highlight && 'text-destructive')}>{c.value}</div>
            </div>
          ))}
        </div>

        {missingOrCorrupt > 0 && (
          <p
            className="text-xs rounded-md border border-border bg-muted/40 p-2"
            data-testid="delivery-excluded"
          >
            {t('tasks:delivery.excluded', {
              missing: metrics.excluded.missing,
              corrupt: metrics.excluded.corrupt
            })}
          </p>
        )}

        <section data-testid="delivery-trend">
          <h3 className="text-sm font-semibold mb-2">{t('tasks:delivery.trend')}</h3>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border">
                <th className={th}>{t('tasks:delivery.columns.date')}</th>
                <th className={th}>{t('tasks:delivery.columns.completed')}</th>
                <th className={th}>{t('tasks:delivery.columns.tokensPerTask')}</th>
              </tr>
            </thead>
            <tbody>
              {metrics.trend.map((p) => {
                const value = p.tokensPerCompletedTask;
                const pct = value !== null && maxTrend > 0 ? Math.round((value / maxTrend) * 100) : 0;
                return (
                  <tr key={p.date} className="border-b border-border/50">
                    <td className={td}>{p.date}</td>
                    <td className={td}>{fmt(p.completedTasks)}</td>
                    <td className={td}>
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-32 rounded bg-muted">
                          <div className="h-2 rounded bg-primary" style={{ width: `${pct}%` }} />
                        </div>
                        <span>{value === null ? '—' : fmt(Math.round(value))}</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        {renderGroups(
          t('tasks:delivery.byPhase'),
          t('tasks:delivery.columns.phase'),
          metrics.byPhase,
          'delivery-by-phase'
        )}
        {renderGroups(
          t('tasks:delivery.byModel'),
          t('tasks:delivery.columns.model'),
          metrics.byModel,
          'delivery-by-model'
        )}

        <p className="text-xs text-muted-foreground" data-testid="delivery-note">
          {t('tasks:delivery.note')}
        </p>
      </div>
    </ScrollArea>
  );
}
