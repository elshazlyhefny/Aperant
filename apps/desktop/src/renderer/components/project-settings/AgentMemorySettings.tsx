import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Database } from 'lucide-react';
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';
import { OllamaContainerPanel } from './OllamaContainerPanel';
import type { MemorySystemStatus } from '../../../shared/types';

/**
 * zeenha fork: the Memory page shows the built-in agent memory, which is what
 * agents actually use (record_memory/search_memory over memory.db). Upstream's
 * page toggled GRAPHITI_ENABLED in the project .env, which nothing in this
 * fork reads.
 *
 * The on/off switch is the app-wide `memoryEnabled` setting (absent = on,
 * isAgentMemoryEnabled), held in the settings dialog's draft and written by
 * its Save button. The embedding provider is shown, not edited: it is
 * auto-detected, and this fork never re-embeds memories stored under a
 * different model.
 */

interface AgentMemorySettingsProps {
  projectId: string;
  /** App settings draft value; undefined means on. */
  memoryEnabled: boolean | undefined;
  onMemoryEnabledChange: (enabled: boolean) => void;
}

type MemoryState = 'off' | 'checking' | 'on' | 'unavailable';

export function agentMemoryState(
  memoryEnabled: boolean | undefined,
  status: MemorySystemStatus | null | undefined,
): MemoryState {
  if (memoryEnabled === false) return 'off';
  if (status === undefined) return 'checking';
  return status?.available === true ? 'on' : 'unavailable';
}

/** EmbeddingService.getProvider() values, as the page names them. */
export function embeddingLabel(provider: string | undefined): { key: string; params?: Record<string, string> } {
  const ollamaSize = provider?.match(/^ollama-(8b|4b|0\.6b)$/)?.[1];
  if (ollamaSize) {
    return { key: 'projectSections.memory.agent.embedding.ollama', params: { model: `qwen3-embedding:${ollamaSize}` } };
  }
  switch (provider) {
    case 'ollama-generic':
      return { key: 'projectSections.memory.agent.embedding.ollamaOther' };
    case 'openai':
      return { key: 'projectSections.memory.agent.embedding.cloud', params: { name: 'OpenAI' } };
    case 'google':
      return { key: 'projectSections.memory.agent.embedding.cloud', params: { name: 'Google AI' } };
    case 'azure':
      return { key: 'projectSections.memory.agent.embedding.cloud', params: { name: 'Azure OpenAI' } };
    case 'voyage':
      return { key: 'projectSections.memory.agent.embedding.cloud', params: { name: 'Voyage AI' } };
    case 'none':
      return { key: 'projectSections.memory.agent.embedding.none' };
    default:
      return { key: 'projectSections.memory.agent.embedding.unknown', params: { provider: provider ?? '?' } };
  }
}

const STATE_BADGE: Record<MemoryState, string> = {
  on: 'bg-success/10 text-success',
  off: 'bg-muted text-muted-foreground',
  checking: 'bg-muted text-muted-foreground',
  unavailable: 'bg-destructive/10 text-destructive',
};

export function AgentMemorySettings({ projectId, memoryEnabled, onMemoryEnabledChange }: AgentMemorySettingsProps) {
  const { t } = useTranslation('settings');
  // undefined while the first check runs; null when it failed
  const [status, setStatus] = useState<MemorySystemStatus | null | undefined>(undefined);
  // bumped after Ollama starts, so the embedding model is read again
  const [statusVersion, setStatusVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (statusVersion === 0) setStatus(undefined);
    window.electronAPI.getMemoryStatus(projectId)
      .then((result) => {
        if (!cancelled) setStatus(result.success && result.data ? result.data : null);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, statusVersion]);

  const state = agentMemoryState(memoryEnabled, status);
  const embedding = embeddingLabel(status?.embeddingProvider);

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Database className="h-4 w-4" />
        {t('projectSections.memory.agent.title')}
        <span className={`px-2 py-0.5 text-xs rounded-full ${STATE_BADGE[state]}`}>
          {t(`projectSections.memory.agent.state.${state}`)}
        </span>
      </div>

      <div className="space-y-4 pl-6">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="agent-memory-enabled" className="font-normal text-foreground">
              {t('projectSections.memory.agent.enable')}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t('projectSections.memory.agent.enableDescription')}
            </p>
          </div>
          <Switch
            id="agent-memory-enabled"
            checked={memoryEnabled !== false}
            onCheckedChange={onMemoryEnabledChange}
          />
        </div>

        {state === 'unavailable' && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3">
            <p className="text-xs text-destructive">
              {status?.reason ?? t('projectSections.memory.agent.unavailable')}
            </p>
          </div>
        )}

        {status?.available && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-lg border border-border bg-muted/30 p-3 text-xs">
            <dt className="text-muted-foreground">{t('projectSections.memory.agent.embeddingLabel')}</dt>
            <dd className="text-foreground">{t(embedding.key, embedding.params)}</dd>

            {status.projectMemoryCount !== undefined && (
              <>
                <dt className="text-muted-foreground">{t('projectSections.memory.agent.storedLabel')}</dt>
                <dd className="text-foreground">
                  {t('projectSections.memory.agent.stored', { count: status.projectMemoryCount })}
                </dd>
              </>
            )}

            {status.dbPath && (
              <>
                <dt className="text-muted-foreground">{t('projectSections.memory.agent.databaseLabel')}</dt>
                <dd className="font-mono text-foreground break-all">{status.dbPath}</dd>
              </>
            )}
          </dl>
        )}

        {status?.embeddingProvider === 'none' && state === 'on' && (
          <p className="text-xs text-warning">{t('projectSections.memory.agent.noSemanticSearch')}</p>
        )}

        <OllamaContainerPanel onStarted={() => setStatusVersion((v) => v + 1)} />

        <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1">
          <p className="text-xs text-muted-foreground">{t('projectSections.memory.agent.embeddingHow')}</p>
          <p className="text-xs text-muted-foreground">{t('projectSections.memory.agent.browse')}</p>
        </div>
      </div>
    </section>
  );
}
