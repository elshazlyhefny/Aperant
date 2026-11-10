/**
 * zeenha fork: headless credential resolution.
 *
 * Mirrors AgentManager.resolveAuthFromProviderQueue without the legacy Claude
 * profile manager or the app's settings file. Electron-free.
 */

import { registerSettingsAccessor, resolveAuth, resolveAuthFromQueue } from '../ai/auth/resolver';
import { PROVIDER_ENV_VARS } from '../ai/auth/types';
import { detectProviderFromModel } from '../ai/providers/factory';
import type { ProviderAccount } from '../../shared/types/provider-account';
import type { HeadlessConfig } from './config';

export interface HeadlessAuthResult {
  auth: { apiKey?: string; baseURL?: string; oauthTokenFilePath?: string; headers?: Record<string, string> };
  provider: string;
  modelId: string;
  configDir?: string;
}

export const NO_CREDENTIALS_MESSAGE =
  'No credentials found. Set one of: ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`), ' +
  'OPENAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, MISTRAL_API_KEY, GROQ_API_KEY, XAI_API_KEY, OPENROUTER_API_KEY, ' +
  'ZHIPU_API_KEY, AZURE_OPENAI_API_KEY; or pass --config with providerAccounts.';

/**
 * Same ordering as AgentManager.resolveAuthFromProviderQueue (duplicated, not
 * shared, so the desktop app's behavior cannot change): priority order first,
 * unlisted accounts after, then the preferred provider's accounts in front.
 */
function orderQueue(
  accounts: ProviderAccount[],
  priorityOrder: string[],
  preferredProvider?: string | null,
): ProviderAccount[] {
  const ordered = priorityOrder
    .map((id) => accounts.find((a) => a.id === id))
    .filter((a): a is ProviderAccount => a != null);
  for (const account of accounts) {
    if (!priorityOrder.includes(account.id)) ordered.push(account);
  }
  if (!preferredProvider) return ordered;
  return [
    ...ordered.filter((a) => a.provider === preferredProvider),
    ...ordered.filter((a) => a.provider !== preferredProvider),
  ];
}

export async function resolveHeadlessAuth(
  modelId: string,
  preferredProvider: string | null | undefined,
  config: HeadlessConfig,
): Promise<HeadlessAuthResult> {
  const settings: Record<string, unknown> = {
    providerAccounts: config.providerAccounts,
    globalPriorityOrder: config.globalPriorityOrder,
    providerAgentConfig: config.providerAgentConfig,
  };
  registerSettingsAccessor((key) => {
    const value = settings[key];
    if (value === undefined || value === null) return undefined;
    return typeof value === 'string' ? value : JSON.stringify(value);
  });

  const accounts = config.providerAccounts ?? [];
  const priorityOrder = config.globalPriorityOrder ?? [];
  if (accounts.length > 0 && priorityOrder.length > 0) {
    const resolved = await resolveAuthFromQueue(modelId, orderQueue(accounts, priorityOrder, preferredProvider));
    if (resolved) {
      return {
        auth: resolved,
        provider: resolved.resolvedProvider,
        modelId: resolved.resolvedModelId,
        configDir: resolved.configDir,
      };
    }
  }

  const provider = detectProviderFromModel(modelId) ?? 'anthropic';

  // A `claude setup-token` token is the anthropic credential when no API key is
  // set; factory.usesClaudeCodeEngine then routes it through the claude CLI.
  // Used directly so CI never reaches for the OS keychain.
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const apiKeyVar = PROVIDER_ENV_VARS.anthropic;
  if (provider === 'anthropic' && oauthToken && !(apiKeyVar && process.env[apiKeyVar])) {
    return { auth: { apiKey: oauthToken }, provider, modelId };
  }

  // Only the existing resolveAuth stages run; keychain failures fall through there.
  const auth = await resolveAuth({ provider });
  if (!auth) throw new Error(NO_CREDENTIALS_MESSAGE);
  return { auth, provider, modelId, configDir: auth.configDir };
}
