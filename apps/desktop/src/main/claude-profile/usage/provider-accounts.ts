/**
 * Provider-account usage (Codex / Z.AI accounts stored in settings.json
 * `providerAccounts`, outside ClaudeProfileManager).
 */

import type { ClaudeUsageSnapshot, ProfileUsageSummary } from '../../../shared/types/agent';
import type { ProviderAccount } from '../../../shared/types/provider-account';
import { readSettingsFileAsync } from '../../settings-utils';
import { ensureValidCodexToken } from '../../ai/auth/codex-oauth';
import { fetchCodexUsage, normalizeCodexResponse } from '../codex-usage-fetcher';
import { calculateAvailabilityScore } from './availability-score';
import { zaiAdapter } from './providers/zai';

export interface ProviderAccountUsageSource {
  provider: 'openai' | 'zai';
  /** Which settings accounts this source handles */
  accountFilter(account: ProviderAccount): boolean;
  /** How `needsReauthentication` is derived when reusing currentUsage */
  currentUsageNeedsReauth: 'copy' | 'false';
  /** Fetch usage for an account that is not the currently-monitored one */
  fetchInactiveUsage(account: ProviderAccount): Promise<ClaudeUsageSnapshot | null>;
  /** Label used in the failure log message */
  label: string;
}

export const codexUsageSource: ProviderAccountUsageSource = {
  provider: 'openai',
  label: 'Codex',
  accountFilter: (account) => account.provider === 'openai' && account.authType === 'oauth',
  currentUsageNeedsReauth: 'copy',
  async fetchInactiveUsage(account) {
    const token = await ensureValidCodexToken();
    if (!token) return null;
    const { getCodexAccountId } = await import('../codex-usage-fetcher');
    const codexAccountId = getCodexAccountId(token);
    const rawData = await fetchCodexUsage(token, codexAccountId);
    if (!rawData) return null;
    return normalizeCodexResponse(rawData, account.id, account.name);
  },
};

export const zaiUsageSource: ProviderAccountUsageSource = {
  provider: 'zai',
  label: 'Z.AI',
  accountFilter: (account) => account.provider === 'zai' && !!account.apiKey,
  currentUsageNeedsReauth: 'false',
  async fetchInactiveUsage(account) {
    // CodeQL: file data in outbound request - validate API key is a non-empty string before use
    const safeApiKey = typeof account.apiKey === 'string' && account.apiKey.length > 0 ? account.apiKey : '';
    // Quirk preserved: raw Authorization header (no Bearer prefix)
    const response = await fetch('https://api.z.ai/api/monitor/usage/quota/limit', {
      headers: {
        'Authorization': safeApiKey,
      },
    });
    if (!response.ok) return null;
    const json = await response.json();
    // Z.AI wraps response in a data field
    const rawData = json.data ?? json;
    return zaiAdapter.normalize(rawData, { profileId: account.id, profileName: account.name }, json);
  },
};

export interface AppendProviderAccountUsageOptions {
  currentUsage: ClaudeUsageSnapshot | null | undefined;
  log: (message: string, data?: unknown) => void;
}

/**
 * Append provider accounts handled by `source` to `allProfiles`.
 */
export async function appendProviderAccountUsage(
  allProfiles: ProfileUsageSummary[],
  source: ProviderAccountUsageSource,
  options: AppendProviderAccountUsageOptions
): Promise<void> {
  const { currentUsage, log } = options;
  try {
    const appSettings = await readSettingsFileAsync();
    if (!appSettings) return;

    const providerAccounts = (appSettings.providerAccounts as ProviderAccount[] | undefined) ?? [];

    for (const account of providerAccounts) {
      if (!source.accountFilter(account)) continue;
      // Skip if already present
      if (allProfiles.some(p => p.profileId === account.id)) continue;

      // If this account matches currentUsage, use that data
      if (currentUsage && currentUsage.profileId === account.id) {
        const s = currentUsage;
        allProfiles.push({
          profileId: s.profileId,
          profileName: s.profileName || account.name,
          profileEmail: s.profileEmail,
          sessionPercent: s.sessionPercent,
          weeklyPercent: s.weeklyPercent,
          sessionResetTimestamp: s.sessionResetTimestamp,
          weeklyResetTimestamp: s.weeklyResetTimestamp,
          isAuthenticated: true,
          isRateLimited: s.sessionPercent >= 95 || s.weeklyPercent >= 95,
          rateLimitType: s.limitType,
          availabilityScore: calculateAvailabilityScore(s.sessionPercent, s.weeklyPercent, false, undefined, true),
          isActive: true,
          lastFetchedAt: s.fetchedAt instanceof Date ? s.fetchedAt.toISOString() : undefined,
          needsReauthentication: source.currentUsageNeedsReauth === 'copy' ? s.needsReauthentication : false,
        });
        continue;
      }

      // Inactive account — try to fetch its usage
      try {
        const n = await source.fetchInactiveUsage(account);
        if (n) {
          allProfiles.push({
            profileId: account.id,
            profileName: account.name,
            profileEmail: n.profileEmail,
            sessionPercent: n.sessionPercent,
            weeklyPercent: n.weeklyPercent,
            sessionResetTimestamp: n.sessionResetTimestamp,
            weeklyResetTimestamp: n.weeklyResetTimestamp,
            isAuthenticated: true,
            isRateLimited: n.sessionPercent >= 95 || n.weeklyPercent >= 95,
            rateLimitType: n.limitType,
            availabilityScore: calculateAvailabilityScore(n.sessionPercent, n.weeklyPercent, false, undefined, true),
            isActive: false,
            lastFetchedAt: new Date().toISOString(),
            needsReauthentication: false,
          });
          continue;
        }
      } catch {
        // Fetch failed — add minimal entry below
      }

      // No data available — add minimal entry so the account appears in the list
      allProfiles.push({
        profileId: account.id,
        profileName: account.name,
        sessionPercent: 0,
        weeklyPercent: 0,
        isAuthenticated: true,
        isRateLimited: false,
        availabilityScore: 100,
        isActive: false,
      });
    }
  } catch (error) {
    log(`[UsageMonitor] Failed to append ${source.label} accounts:`, error);
  }
}
