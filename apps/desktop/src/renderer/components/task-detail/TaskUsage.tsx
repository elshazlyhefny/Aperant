import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, AlertCircle, RefreshCw, Activity } from 'lucide-react';
import { ScrollArea } from '../ui/scroll-area';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import { useProjectStore } from '../../stores/project-store';
import { formatDuration, formatTokens } from './usage-format';
import type { Task } from '../../../shared/types';
import type { TaskRunMetrics, RunMetricsGroup } from '../../../shared/types/run-metrics';

interface TaskUsageProps {
  task: Task;
}

export function TaskUsage({ task }: TaskUsageProps) {
  const { t, i18n } = useTranslation(['tasks']);
  const activeProject = useProjectStore((s) => s.getActiveProject());
  const projectId = activeProject?.id;

  const [metrics, setMetrics] = useState<TaskRunMetrics | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    setIsLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.getTaskRunMetrics(projectId, task.specId);
      if (!result.success) {
        throw new Error(result.error || 'Failed to load usage');
      }
      setMetrics(result.data ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  }, [projectId, task.specId]);

  useEffect(() => {
    load();
  }, [load]);

  const fmt = (n: number) => formatTokens(n, i18n.language);

  if (isLoading && !metrics) {
    return (
      <div className="h-full flex items-center justify-center" data-testid="task-usage-loading">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">{t('tasks:usage.loading')}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center" data-testid="task-usage-error">
        <div className="text-center">
          <AlertCircle className="h-8 w-8 mx-auto mb-2 text-destructive" />
          <p className="text-sm text-destructive mb-2">{t('tasks:usage.error')}</p>
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="h-3 w-3 mr-1" />
            {t('tasks:usage.retry')}
          </Button>
        </div>
      </div>
    );
  }

  if (!metrics || metrics.summary.sessionCount === 0) {
    return (
      <div className="h-full flex items-center justify-center" data-testid="task-usage-empty">
        <div className="text-center py-12">
          <Activity className="h-10 w-10 mx-auto mb-3 text-muted-foreground/30" />
          <p className="text-sm font-medium text-muted-foreground mb-1">{t('tasks:usage.empty')}</p>
          <p className="text-xs text-muted-foreground">{t('tasks:usage.emptyHint')}</p>
        </div>
      </div>
    );
  }

  const { summary } = metrics;

  const cards: Array<{ label: string; value: string }> = [
    { label: t('tasks:usage.totals.sessions'), value: fmt(summary.sessionCount) },
    { label: t('tasks:usage.totals.duration'), value: formatDuration(summary.durationMs) },
    { label: t('tasks:usage.totals.toolTime'), value: formatDuration(summary.toolTimeMs) },
    { label: t('tasks:usage.tokens.input'), value: fmt(summary.tokens.input) },
    { label: t('tasks:usage.tokens.output'), value: fmt(summary.tokens.output) },
    { label: t('tasks:usage.tokens.cacheRead'), value: fmt(summary.tokens.cacheRead) },
    { label: t('tasks:usage.tokens.cacheCreation'), value: fmt(summary.tokens.cacheCreation) }
  ];

  const th = 'text-left font-medium text-muted-foreground px-2 py-1';
  const td = 'px-2 py-1';

  const renderGroups = (title: string, firstColumn: string, groups: RunMetricsGroup[], testId: string) => (
    <section data-testid={testId}>
      <h3 className="text-sm font-semibold mb-2">{title}</h3>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border">
            <th className={th}>{firstColumn}</th>
            <th className={th}>{t('tasks:usage.columns.sessions')}</th>
            <th className={th}>{t('tasks:usage.columns.duration')}</th>
            <th className={th}>{t('tasks:usage.columns.tokens')}</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.key} className="border-b border-border/50">
              <td className={td}>{g.key}</td>
              <td className={td}>{fmt(g.sessions)}</td>
              <td className={td}>{formatDuration(g.durationMs)}</td>
              <td className={td}>
                {fmt(g.tokens.input)} / {fmt(g.tokens.output)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );

  return (
    <ScrollArea className="h-full">
      <div className="p-4 space-y-6" data-testid="task-usage">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t('tasks:usage.title')}</h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={load}
            disabled={isLoading}
            aria-label={t('tasks:usage.refresh')}
          >
            <RefreshCw className={cn('h-3 w-3 mr-1', isLoading && 'animate-spin')} />
            {t('tasks:usage.refresh')}
          </Button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {cards.map((c) => (
            <div key={c.label} className="rounded-md border border-border p-3">
              <div className="text-xs text-muted-foreground">{c.label}</div>
              <div className="text-lg font-semibold">{c.value}</div>
            </div>
          ))}
        </div>

        {renderGroups(t('tasks:usage.byPhase'), t('tasks:usage.columns.phase'), summary.byPhase, 'usage-by-phase')}
        {renderGroups(t('tasks:usage.byAgent'), t('tasks:usage.columns.agent'), summary.byAgent, 'usage-by-agent')}

        <section data-testid="usage-by-tool">
          <h3 className="text-sm font-semibold mb-2">{t('tasks:usage.byTool')}</h3>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border">
                <th className={th}>{t('tasks:usage.columns.tool')}</th>
                <th className={th}>{t('tasks:usage.columns.calls')}</th>
                <th className={th}>{t('tasks:usage.columns.errors')}</th>
                <th className={th}>{t('tasks:usage.columns.totalTime')}</th>
              </tr>
            </thead>
            <tbody>
              {summary.byTool.map((tool) => (
                <tr key={tool.tool} className="border-b border-border/50">
                  <td className={td}>{tool.tool}</td>
                  <td className={td}>{fmt(tool.calls)}</td>
                  <td
                    className={cn(td, tool.errors > 0 && 'text-destructive font-medium')}
                    data-testid={`usage-tool-errors-${tool.tool}`}
                  >
                    {fmt(tool.errors)}
                  </td>
                  <td className={td}>{formatDuration(tool.totalMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {summary.slowest.length > 0 && (
          <section data-testid="usage-slowest">
            <h3 className="text-sm font-semibold mb-2">{t('tasks:usage.slowest')}</h3>
            <table className="w-full text-xs table-fixed">
              <thead>
                <tr className="border-b border-border">
                  <th className={th}>{t('tasks:usage.columns.tool')}</th>
                  <th className={th}>{t('tasks:usage.columns.duration')}</th>
                  <th className={th}>{t('tasks:usage.columns.agent')}</th>
                  <th className={cn(th, 'w-1/3')}>{t('tasks:usage.columns.detail')}</th>
                </tr>
              </thead>
              <tbody>
                {summary.slowest.map((call, i) => (
                  <tr key={`${call.tool}-${i}`} className="border-b border-border/50">
                    <td className={td}>{call.tool}</td>
                    <td className={td}>{formatDuration(call.ms)}</td>
                    <td className={td}>
                      {call.agentType} / {call.phase}
                    </td>
                    <td className={cn(td, 'truncate font-mono')} title={call.detail}>
                      {call.detail}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        <p className="text-xs text-muted-foreground">{t('tasks:usage.note')}</p>
      </div>
    </ScrollArea>
  );
}
