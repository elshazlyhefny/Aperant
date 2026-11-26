// zeenha fork: per-phase provider routing. A task chooses Claude, Codex, or both
// (upstream has no per-task agent choice), so each phase resolves its own account
// from that phase's provider queue in the main process when the phase starts.
// Only the current phase's credentials cross the worker boundary.
import { ALL_AVAILABLE_MODELS } from '../../../shared/constants/models';
import type { ProviderAccount } from '../../../shared/types/provider-account';
import type { Phase } from '../config/types';
import { resolveModelId } from '../config/phase-config';
import { resolveAuthFromQueue } from '../auth/resolver';
import type { ResolvedAuth } from '../auth/types';
import type { TaskMetadata } from './task-session';
import type { PhaseConnection } from './types';

interface PhaseAccounts {
  accounts: ProviderAccount[];
  priorityOrder: string[];
  codexTokenFilePath?: string;
  fallback: (provider: string) => Promise<ResolvedAuth | null>;
}

export function phaseConnectionResolver(metadata: TaskMetadata | null | undefined, getAccounts: () => PhaseAccounts) {
  const assignments = metadata?.phaseProviders;
  if (!assignments || !Object.keys(assignments).length) return undefined;

  // excludeAccountIds: accounts this task must skip, e.g. one that just hit a rate
  // limit, so the phase moves to the next account of the same provider.
  return async (phase: Phase, excludeAccountIds: string[] = []): Promise<PhaseConnection> => {
    const provider = assignments[phase] ?? metadata.provider;
    const modelId = resolveModelId(metadata.phaseModels?.[phase] ?? metadata.model ?? 'sonnet');
    const label = provider === 'openai' ? 'Codex (OpenAI)' : provider === 'anthropic' ? 'Claude (Anthropic)' : provider;
    const unavailable = new Error(`The ${phase} phase needs a usable ${label ?? 'provider'} account. Connect the account or change the task agent, then resume.`);
    if (!provider) throw unavailable;
    const { accounts, priorityOrder, codexTokenFilePath, fallback } = getAccounts();
    const rank = (id: string) => {
      const index = priorityOrder.indexOf(id);
      return index < 0 ? Infinity : index;
    };
    const queue = accounts.filter(a => a.provider === provider).sort((a, b) => rank(a.id) - rank(b.id));
    const thinkingLevel = metadata.phaseThinking?.[phase];
    // Never retry an exhausted or rejected configured account via the legacy resolver.
    if (queue.length) {
      const keyOnly = ALL_AVAILABLE_MODELS.some(model => model.provider === provider && model.value === modelId && model.apiKeyOnly);
      const eligible = keyOnly ? queue.filter(a => a.authType === 'api-key') : queue;
      const resolved = await resolveAuthFromQueue(modelId, eligible, { codexTokenFilePath, excludeAccountIds });
      if (!resolved) throw unavailable;
      return {
        provider: resolved.resolvedProvider,
        modelId: resolved.resolvedModelId,
        thinkingLevel,
        apiKey: resolved.apiKey,
        configDir: resolved.configDir,
        baseURL: resolved.baseURL,
        oauthTokenFilePath: resolved.oauthTokenFilePath,
        accountId: resolved.accountId,
      };
    }
    const auth = await fallback(provider);
    if (!auth) throw unavailable;
    return { provider, modelId, thinkingLevel, apiKey: auth.apiKey, configDir: auth.configDir,
      baseURL: auth.baseURL, oauthTokenFilePath: auth.oauthTokenFilePath };
  };
}
