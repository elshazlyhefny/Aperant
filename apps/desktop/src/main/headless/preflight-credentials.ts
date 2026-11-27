/** zeenha fork: check credential configuration without initializing auth or any provider SDK. */

import { statSync } from 'node:fs';

import type { ProviderAccount } from '../../shared/types/provider-account';
import { readTaskMetadata, resolveTaskModelId, resolveTaskPhaseProvider } from '../ai/agent/task-session';
import { NO_AUTH_PROVIDERS, PROVIDER_ENV_VARS } from '../ai/auth/types';
import { resolveModelId } from '../ai/config/phase-config';
import { MODEL_PROVIDER_MAP } from '../ai/config/types';
import type { SupportedProvider } from '../ai/providers/types';
import type { HeadlessConfig } from './config';
import type { PreflightCheck } from './preflight';
import { providerPhaseModels } from './shared';

// Same guidance as auth.ts, without importing the runtime resolver.
const NO_CREDENTIALS_MESSAGE =
  'No credentials found. Set one of: ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`), ' +
  'OPENAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, MISTRAL_API_KEY, GROQ_API_KEY, XAI_API_KEY, OPENROUTER_API_KEY, ' +
  'ZHIPU_API_KEY, AZURE_OPENAI_API_KEY; or pass --config with providerAccounts.';

export const PREFLIGHT_SPEC_PHASES = ['planning', 'coding', 'qa'] as const;
type Phase = (typeof PREFLIGHT_SPEC_PHASES)[number] | 'default';

interface CredentialOptions {
  phase: Phase;
  specDir?: string;
  config: HeadlessConfig;
  env: NodeJS.ProcessEnv;
  fileExists?: (filePath: string) => boolean;
}

interface LocalCredential {
  provider: string;
  source: string;
  status: 'valid' | 'unverified';
  message: string;
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

// Use the same prefix map as factory.detectProviderFromModel without loading provider SDKs or OAuth.
function detectProviderFromModel(model: string): SupportedProvider | undefined {
  return Object.entries(MODEL_PROVIDER_MAP).find(([prefix]) => model.startsWith(prefix))?.[1];
}

function hasValue(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Match the runtime's priority order, then promote accounts of the preferred provider. */
function orderQueue(accounts: ProviderAccount[], priorityOrder: string[], preferred: string | null): ProviderAccount[] {
  const ordered = priorityOrder
    .map((id) => accounts.find((account) => account.id === id))
    .filter((account): account is ProviderAccount => account !== undefined);
  ordered.push(...accounts.filter((account) => !priorityOrder.includes(account.id)));
  return preferred
    ? [...ordered.filter((account) => account.provider === preferred), ...ordered.filter((account) => account.provider !== preferred)]
    : ordered;
}

function inspectAccount(
  account: ProviderAccount, config: HeadlessConfig, fileExists: (filePath: string) => boolean,
): LocalCredential | undefined {
  const { provider } = account;
  const source = typeof account.id === 'string' ? `account:${account.id}` : 'none';
  if (NO_AUTH_PROVIDERS.has(provider)) {
    return { provider, source, status: 'valid', message: `${provider} does not require credentials` };
  }
  if (account.authType === 'api-key' && hasValue(account.apiKey) && account.keyStatus !== 'rejected') {
    return { provider, source, status: 'valid', message: `API key configured in a ${provider} account` };
  }
  if (account.authType === 'oauth') {
    if (provider === 'openai' && hasValue(config.codexTokenFilePath) && fileExists(config.codexTokenFilePath)) {
      return { provider, source, status: 'unverified', message: 'Codex token file exists; contents and expiry were not checked' };
    }
    if (provider === 'anthropic' && hasValue(account.claudeProfileId)) {
      return { provider, source, status: 'unverified', message: 'Claude OAuth profile configured; the OS keychain was not checked' };
    }
  }
  return undefined;
}

function fallbackEnvVars(provider: string | null, pinned: boolean): string[] {
  if (provider === 'anthropic') return ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];
  if (provider === 'openai') return ['OPENAI_API_KEY'];
  if (pinned || !provider || !Object.hasOwn(PROVIDER_ENV_VARS, provider)) return [];
  const envVar = PROVIDER_ENV_VARS[provider as SupportedProvider];
  return envVar ? [envVar] : [];
}

export async function checkPhaseCredentials({ phase, specDir, config, env, fileExists = isFile }: CredentialOptions): Promise<PreflightCheck> {
  const metadata = phase !== 'default' && specDir ? readTaskMetadata(specDir) : null;
  const pinned = Boolean(metadata?.phaseProviders && Object.keys(metadata.phaseProviders).length);
  // A pinned phase reads its model straight from the metadata instead of resolveTaskModelId.
  // This only affects details.model; the status depends on the pinned provider alone.
  const rawModel = pinned ? metadata?.phaseModels?.[phase] ?? metadata?.model : undefined;
  const modelId = pinned || !specDir || phase === 'default'
    ? resolveModelId(hasValue(rawModel) ? rawModel : 'sonnet')
    : await resolveTaskModelId(specDir, phase, providerPhaseModels(config));
  const model = hasValue(modelId) ? modelId : resolveModelId('sonnet');
  const assigned = metadata?.phaseProviders?.[phase] ?? metadata?.provider;
  const provider = pinned ? (hasValue(assigned) ? assigned : null) : detectProviderFromModel(model) ?? 'anthropic';
  const preferred = !pinned && specDir && phase !== 'default' ? resolveTaskPhaseProvider(specDir, phase) : null;
  // The config loader validates the array but not its individual entries.
  const accounts = (config.providerAccounts ?? []).filter((account) => typeof account?.provider === 'string');
  const queue = orderQueue(
    pinned ? accounts.filter((account) => account.provider === provider) : accounts,
    config.globalPriorityOrder ?? [],
    preferred,
  );
  const envVars = fallbackEnvVars(provider, pinned);
  const canUseFallback = !pinned || queue.length === 0;
  const code = `credentials.${phase}` as const;
  const result = ({ provider, source, status, message }: LocalCredential): PreflightCheck => ({
    code, status, blocking: false, message, details: { phase, provider, model, source, pinned },
  });

  // Keep the first untestable candidate, but keep looking for a locally complete one.
  let unverified: LocalCredential | undefined;
  for (const account of queue) {
    const credential = inspectAccount(account, config, fileExists);
    if (credential?.status === 'valid') return result(credential);
    unverified ??= credential;
  }
  if (provider && canUseFallback) {
    const envVar = envVars.find((name) => hasValue(env[name]));
    if (envVar) return result({ provider, source: `env:${envVar}`, status: 'valid', message: `${envVar} is set` });
    if (!pinned && NO_AUTH_PROVIDERS.has(provider)) {
      return result({ provider, source: 'none', status: 'valid', message: `${provider} does not require credentials` });
    }
    if (!pinned && provider === 'bedrock') {
      unverified ??= { provider, source: 'none', status: 'unverified', message: 'The AWS credential chain was not checked' };
    }
  }
  if (unverified) return result(unverified);

  let guidance: string;
  if (!provider) {
    guidance = 'Set a provider for this phase or change the task agent.';
  } else if (!canUseFallback) {
    guidance = `Fix the configured ${provider} accounts in --config.`;
    if (envVars.length) guidance += ` To use ${envVars.join(' or ')} instead, first remove those accounts.`;
  } else if (envVars.length) {
    guidance = `Set ${envVars.join(' or ')}; or pass --config with providerAccounts.`;
  } else {
    guidance = pinned ? `Pass --config with providerAccounts for ${provider}.` : NO_CREDENTIALS_MESSAGE;
  }
  return {
    code, status: 'unavailable', blocking: true,
    message: provider ? `No usable local credentials for ${provider}` : `No provider assigned to the ${phase} phase`,
    guidance, details: { phase, provider, model, source: 'none', pinned },
  };
}
