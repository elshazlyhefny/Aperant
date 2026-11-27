import { isSecretEnvelope } from '../../../shared/utils/secret-envelope';
import { readSettingsFile } from '../../settings-utils';

/**
 * Check if any provider account is configured for OAuth, no auth, or a usable API key.
 * Used to bypass the legacy hasValidAuth() check for non-Anthropic providers.
 */
export function hasAnyProviderAccount(): boolean {
  const accounts = readSettingsFile()?.providerAccounts ?? [];
  return accounts.some(({ authType, provider, apiKey }) =>
    authType !== 'api-key' || provider === 'ollama' || (!!apiKey && !isSecretEnvelope(apiKey))
  );
}

/**
 * True when either the legacy Claude profile has valid auth or a provider
 * account is configured.
 */
export function hasUsableAuth(profileManager: { hasValidAuth(): boolean }): boolean {
  return profileManager.hasValidAuth() || hasAnyProviderAccount();
}
