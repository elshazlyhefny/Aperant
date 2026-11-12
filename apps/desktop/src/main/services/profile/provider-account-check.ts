import { readSettingsFile } from '../../settings-utils';

/**
 * Check if any provider account is configured (API key or OAuth).
 * Used to bypass the legacy hasValidAuth() check for non-Anthropic providers.
 */
export function hasAnyProviderAccount(): boolean {
  const accounts = readSettingsFile()?.providerAccounts ?? [];
  return accounts.length > 0;
}

/**
 * True when either the legacy Claude profile has valid auth or a provider
 * account is configured.
 */
export function hasUsableAuth(profileManager: { hasValidAuth(): boolean }): boolean {
  return profileManager.hasValidAuth() || hasAnyProviderAccount();
}
