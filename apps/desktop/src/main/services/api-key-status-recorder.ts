/**
 * API key outcome recorder.
 *
 * Persists whether an API key was confirmed ('valid') or rejected by its
 * provider, so failover can avoid keys known to be bad. Covers both credential
 * stores: settings.json providerAccounts and profiles.json APIProfiles.
 *
 * Never throws: it runs inside agent result handling.
 */

import { updateSettingsFile } from '../settings-utils';
import { atomicModifyProfiles } from './profile/api-profile-store';
import { extractProfileId } from '../../shared/utils/unified-account';
import { getKeyStatus, withKeyStatus } from '../../shared/utils/api-key-status';
import type { ApiKeyStatus, ConnectionErrorType } from '../../shared/types/profile';

export type ApiKeyOutcome = 'valid' | 'rejected';

/**
 * Map a test-connection error type to a key outcome.
 * Only 'auth' marks a key; temporary failures (network, timeout, ...) never do.
 */
export function outcomeFromConnectionError(errorType?: ConnectionErrorType): 'rejected' | null {
  return errorType === 'auth' ? 'rejected' : null;
}

async function recordForProviderAccount(
  accountId: string,
  status: ApiKeyStatus
): Promise<boolean | null> {
  return updateSettingsFile((settings) => {
    const accounts = settings.providerAccounts;
    const index = accounts?.findIndex((a) => a.id === accountId) ?? -1;
    if (!accounts || index === -1) return null;

    const account = accounts[index];
    if (account.authType !== 'api-key') return false;
    if (getKeyStatus(account) === status) return false;

    accounts[index] = withKeyStatus(account, status);
    return true;
  });
}

/**
 * Record a key outcome for a provider account id or an API profile id
 * (bare or `api-` prefixed). Returns true only when something was written.
 */
export async function recordApiKeyOutcome(
  accountId: string,
  outcome: ApiKeyOutcome
): Promise<boolean> {
  try {
    const providerResult = await recordForProviderAccount(accountId, outcome);
    if (providerResult !== null) return providerResult;
    if (accountId.startsWith('pa_')) return false;

    const profileId = extractProfileId(accountId);
    let changed = false;
    await atomicModifyProfiles((file) => {
      const index = file.profiles.findIndex((p) => p.id === profileId);
      if (index === -1 || getKeyStatus(file.profiles[index]) === outcome) return file;
      file.profiles[index] = withKeyStatus(file.profiles[index], outcome);
      changed = true;
      return file;
    });
    return changed;
  } catch (error) {
    console.warn('[api-key-status-recorder] Failed to record key outcome:', error);
    return false;
  }
}
