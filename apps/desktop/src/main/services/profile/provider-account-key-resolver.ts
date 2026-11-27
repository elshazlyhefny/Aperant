import { isSecretEnvelope } from '../../../shared/utils/secret-envelope';
import { readSettingsFile } from '../../settings-utils';

type SavedKeyResolution =
  | { ok: true; apiKey: string; baseUrl: string }
  | { ok: false; error: 'account_not_found' | 'no_saved_key' | 'endpoint_mismatch' };

function normalizeEndpoint(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(
    /^([a-z][a-z\d+.-]*:\/\/)?([^/?#\\]+)/i,
    (_match, scheme: string | undefined, authority: string) => {
      // Keep user info (if present), path, and query case-sensitive.
      const hostStart = authority.lastIndexOf('@') + 1;
      return (scheme ?? '').toLowerCase() + authority.slice(0, hostStart) + authority.slice(hostStart).toLowerCase();
    }
  );
}

export function resolveSavedProviderKey(accountId: string, requestedBaseUrl: string): SavedKeyResolution {
  const accounts = readSettingsFile()?.providerAccounts;
  const account = Array.isArray(accounts) ? accounts.find((entry) => entry?.id === accountId) : undefined;
  if (!account) return { ok: false, error: 'account_not_found' };

  const apiKey = typeof account.apiKey === 'string' ? account.apiKey.trim() : '';
  // zeenha fork: an undecryptable envelope is never sent as a credential.
  if (!apiKey || isSecretEnvelope(apiKey)) return { ok: false, error: 'no_saved_key' };

  // zeenha fork: use the stored endpoint, never a renderer-selected destination, with a saved key.
  const baseUrl = typeof account.baseUrl === 'string' ? normalizeEndpoint(account.baseUrl) : '';
  if (!baseUrl || typeof requestedBaseUrl !== 'string' || normalizeEndpoint(requestedBaseUrl) !== baseUrl) {
    return { ok: false, error: 'endpoint_mismatch' };
  }

  return { ok: true, apiKey, baseUrl };
}
