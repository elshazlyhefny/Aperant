/**
 * zeenha fork: headless credential resolution.
 *
 * Mirrors AgentManager.resolveAuthFromProviderQueue without the legacy Claude
 * profile manager or the app's settings file. Electron-free.
 */

import { registerSettingsAccessor, resolveAuth, resolveAuthFromQueue } from '../ai/auth/resolver';
import { PROVIDER_ENV_VARS, type ResolvedAuth } from '../ai/auth/types';
import { detectProviderFromModel } from '../ai/providers/factory';
import type { ProviderAccount } from '../../shared/types/provider-account';
import type { HeadlessConfig } from './config';
import { readHeadlessRateLimits, withHeadlessRateLimits } from './rate-limit-state';

export interface HeadlessAuthResult {
  auth: { apiKey?: string; baseURL?: string; oauthTokenFilePath?: string; headers?: Record<string, string> };
  provider: string;
  modelId: string;
  configDir?: string;
  /** zeenha fork: the provider account used, so a rate limit can be recorded on it. */
  accountId?: string;
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

// zeenha fork: say why no account was usable when recorded rate limits are the reason.
function rateLimitedMessage(accounts: ProviderAccount[]): string | undefined {
  const now = Date.now();
  const resets = accounts.flatMap((a) => a.rateLimitEvents ?? [])
    .map((e) => new Date(e.resetAt).getTime())
    .filter((ms) => ms > now);
  if (!resets.length) return undefined;
  return `No configured provider account is usable right now; the earliest recorded rate limit resets at ${new Date(Math.min(...resets)).toISOString()}.`;
}

export async function resolveHeadlessAuth(
  modelId: string,
  preferredProvider: string | null | undefined,
  config: HeadlessConfig,
  /**
   * zeenha fork: the project whose recorded rate limits (headless/rate-limit-state.ts)
   * apply, so an account stays skipped until its reset. Omitted = none apply.
   */
  projectPath?: string,
): Promise<HeadlessAuthResult> {
  const limits = projectPath ? readHeadlessRateLimits(projectPath) : {};
  const settings: Record<string, unknown> = {
    // zeenha fork: the legacy fallback below must not pick an account that is
    // rate-limited until a recorded reset.
    providerAccounts: config.providerAccounts?.filter((a) => !limits[a.id]),
    globalPriorityOrder: config.globalPriorityOrder,
    providerAgentConfig: config.providerAgentConfig,
    codexTokenFilePath: config.codexTokenFilePath,
  };
  registerSettingsAccessor((key) => {
    const value = settings[key];
    if (value === undefined || value === null) return undefined;
    return typeof value === 'string' ? value : JSON.stringify(value);
  });

  const accounts = withHeadlessRateLimits(config.providerAccounts, limits);
  const priorityOrder = config.globalPriorityOrder ?? [];
  if (accounts.length > 0) {
    const resolved = await resolveAuthFromQueue(modelId, orderQueue(accounts, priorityOrder, preferredProvider), { codexTokenFilePath: config.codexTokenFilePath });
    if (resolved) {
      return {
        auth: resolved,
        provider: resolved.resolvedProvider,
        modelId: resolved.resolvedModelId,
        configDir: resolved.configDir,
        accountId: resolved.accountId,
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
  if (!auth) throw new Error(rateLimitedMessage(accounts) ?? NO_CREDENTIALS_MESSAGE);
  return { auth, provider, modelId, configDir: auth.configDir };
}


// A pinned phase can only use environment credentials for its own provider.
// This fallback is independent of the process-wide settings accessor.
export async function resolveHeadlessPhaseFallback(provider: string): Promise<ResolvedAuth | null> {
  if (provider !== 'openai' && provider !== 'anthropic') return null;
  const apiKey = provider === 'openai' ? process.env.OPENAI_API_KEY
    : process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!apiKey) return null;
  return { apiKey, source: 'environment',
    baseURL: provider === 'openai' ? process.env.OPENAI_BASE_URL : process.env.ANTHROPIC_BASE_URL };
}
