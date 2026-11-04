import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Play, RefreshCw, Server } from 'lucide-react';
import { Button } from '../ui/button';
import type { OllamaContainerStatus } from '../../../shared/types';

/**
 * zeenha fork: the `ollama` Docker container that serves memory embeddings —
 * its state, CPU, memory and disk use, and a Start button. When it is down,
 * memory search silently falls back to keywords.
 */

const POLL_MS = 10_000;
const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

/** Binary units, as Docker and `df -h` print them. */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return '?';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${UNITS[unit]}`;
}

type Badge = 'running' | 'stopped' | 'missing' | 'unavailable' | 'checking';

export function ollamaBadge(status: OllamaContainerStatus | null | undefined): Badge {
  if (status === undefined) return 'checking';
  if (status === null || status.docker === 'unavailable') return 'unavailable';
  if (status.container === 'running') return 'running';
  return status.container === 'missing' ? 'missing' : 'stopped';
}

const BADGE_CLASS: Record<Badge, string> = {
  running: 'bg-success/10 text-success',
  stopped: 'bg-destructive/10 text-destructive',
  missing: 'bg-destructive/10 text-destructive',
  unavailable: 'bg-muted text-muted-foreground',
  checking: 'bg-muted text-muted-foreground',
};

interface OllamaContainerPanelProps {
  /** Called after a successful start, so the page re-reads the memory status. */
  onStarted: () => void;
}

export function OllamaContainerPanel({ onStarted }: OllamaContainerPanelProps) {
  const { t, i18n } = useTranslation('settings');
  // undefined while the first check runs; null when the check itself failed
  const [status, setStatus] = useState<OllamaContainerStatus | null | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    try {
      const result = await window.electronAPI.getOllamaContainerStatus();
      if (mounted.current) setStatus(result.success && result.data ? result.data : null);
    } catch {
      if (mounted.current) setStatus(null);
    } finally {
      inFlight.current = false;
      if (mounted.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const result = await window.electronAPI.startOllamaContainer();
      if (!mounted.current) return;
      if (result.success && result.data) {
        setStatus(result.data);
        onStarted();
      } else {
        setError(result.error ?? t('projectSections.memory.ollama.startFailed'));
      }
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : t('projectSections.memory.ollama.startFailed'));
    } finally {
      if (mounted.current) setStarting(false);
    }
  };

  const badge = ollamaBadge(status);
  const when = (iso: string | undefined) =>
    iso && !iso.startsWith('0001') ? new Date(iso).toLocaleString(i18n.language) : '?';
  const modelBytes = status?.models?.reduce((sum, m) => sum + m.bytes, 0);
  const loaded = new Set(status?.loadedModels?.map((m) => m.name));

  return (
    <div className="rounded-lg border border-border p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Server className="h-4 w-4" />
          {t('projectSections.memory.ollama.title')}
          <span className={`px-2 py-0.5 text-xs rounded-full ${BADGE_CLASS[badge]}`}>
            {t(`projectSections.memory.ollama.badge.${badge}`)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={refresh}
            disabled={refreshing || starting}
            aria-label={t('projectSections.memory.ollama.refresh')}
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
          {badge === 'stopped' && (
            <Button size="sm" onClick={start} disabled={starting}>
              {starting ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Play className="h-4 w-4 mr-1" />}
              {starting ? t('projectSections.memory.ollama.starting') : t('projectSections.memory.ollama.start')}
            </Button>
          )}
        </div>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {badge === 'unavailable' && (
        <p className="text-xs text-muted-foreground">
          {t('projectSections.memory.ollama.dockerUnavailable', { detail: status?.detail ?? '?' })}
        </p>
      )}

      {badge === 'missing' && (
        <p className="text-xs text-muted-foreground">{t('projectSections.memory.ollama.missing')}</p>
      )}

      {badge === 'stopped' && (
        <p className="text-xs text-muted-foreground">
          {t('projectSections.memory.ollama.stoppedSince', {
            state: status?.state ?? '?',
            date: when(status?.finishedAt),
            code: status?.exitCode ?? '?',
          })}
        </p>
      )}

      {status && status.docker === 'ok' && status.container !== 'missing' && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-xs">
          {badge === 'running' && (
            <>
              <dt className="text-muted-foreground">{t('projectSections.memory.ollama.upLabel')}</dt>
              <dd className="text-foreground">
                {t('projectSections.memory.ollama.upSince', { date: when(status.startedAt) })}
                {status.apiReachable === false && (
                  <span className="text-warning"> · {t('projectSections.memory.ollama.apiDown')}</span>
                )}
              </dd>

              <dt className="text-muted-foreground">{t('projectSections.memory.ollama.cpuLabel')}</dt>
              <dd className="text-foreground">
                {status.cpuPercent !== undefined ? `${status.cpuPercent.toFixed(1)}%` : '?'}
                {status.cpuLimit !== undefined && ` · ${t('projectSections.memory.ollama.cpuLimit', { count: status.cpuLimit })}`}
              </dd>

              <dt className="text-muted-foreground">{t('projectSections.memory.ollama.memoryLabel')}</dt>
              <dd className="text-foreground">
                {t('projectSections.memory.ollama.memoryOf', {
                  used: formatBytes(status.memoryBytes),
                  limit: formatBytes(status.memoryLimitBytes),
                })}
              </dd>
            </>
          )}

          {status.models && (
            <>
              <dt className="text-muted-foreground">{t('projectSections.memory.ollama.modelsLabel')}</dt>
              <dd className="text-foreground">
                {status.models.length === 0
                  ? t('projectSections.memory.ollama.noModels')
                  : status.models.map((m) => (
                      <div key={m.name}>
                        <span className="font-mono">{m.name}</span> ({formatBytes(m.bytes)})
                        {loaded.has(m.name) && (
                          <span className="text-muted-foreground"> · {t('projectSections.memory.ollama.loaded')}</span>
                        )}
                      </div>
                    ))}
              </dd>
            </>
          )}

          <dt className="text-muted-foreground">{t('projectSections.memory.ollama.diskLabel')}</dt>
          <dd className="text-foreground">
            {[
              modelBytes !== undefined && t('projectSections.memory.ollama.diskModels', { size: formatBytes(modelBytes) }),
              status.imageBytes !== undefined && t('projectSections.memory.ollama.diskImage', { size: formatBytes(status.imageBytes) }),
              status.diskFreeBytes !== undefined &&
                t('projectSections.memory.ollama.diskFree', {
                  free: formatBytes(status.diskFreeBytes),
                  total: formatBytes(status.diskTotalBytes),
                }),
            ]
              .filter(Boolean)
              .join(' · ') || '?'}
          </dd>
        </dl>
      )}
    </div>
  );
}
