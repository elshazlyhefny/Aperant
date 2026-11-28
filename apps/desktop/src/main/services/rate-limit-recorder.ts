/**
 * zeenha fork: account rate-limit recorder.
 *
 * Agent sessions that hit a rate limit used to leave no trace on the account,
 * so scoring (scoreProviderAccount) and the task queue kept treating an
 * exhausted account as available and started task after task into it. This
 * records the limit on the ProviderAccount (settings.json providerAccounts)
 * and on its linked Claude profile.
 *
 * Never throws: it runs inside agent result handling.
 */

import { updateSettingsFile } from '../settings-utils';
import { getClaudeProfileManager } from '../claude-profile-manager';
import { rateLimitResetDate, withRateLimitEvent } from './rate-limit-events';
import type { ProviderAccount } from '../../shared/types/provider-account';

// zeenha fork: the event rules live in rate-limit-events.ts so the headless CLI
// can share them without Electron; re-exported for existing callers.
export { DEFAULT_RATE_LIMIT_COOLDOWN_MS, withRateLimitEvent } from './rate-limit-events';

/**
 * Record a rate limit for a provider account id (resetAt in ms, or null when
 * unknown) on the account and on its linked Claude profile.
 */
export async function recordAccountRateLimit(accountId: string, resetAt: number | null): Promise<void> {
  const now = Date.now();
  const reset = rateLimitResetDate(resetAt, now);
  let claudeProfileId: string | undefined;
  try {
    await updateSettingsFile((settings) => {
      const accounts: ProviderAccount[] | undefined = settings.providerAccounts;
      const index = accounts?.findIndex((a) => a.id === accountId) ?? -1;
      if (!accounts || index === -1) return;
      const account = accounts[index];
      claudeProfileId = account.claudeProfileId;
      accounts[index] = { ...account, rateLimitEvents: withRateLimitEvent(account.rateLimitEvents, reset, now) };
    });
  } catch {
    console.warn('[rate-limit-recorder] Failed to record the rate limit on the provider account');
  }
  if (!claudeProfileId) return;
  try {
    getClaudeProfileManager().recordRateLimitEvent(claudeProfileId, reset.toISOString(), reset);
  } catch {
    console.warn('[rate-limit-recorder] Failed to record the rate limit on the Claude profile');
  }
}
