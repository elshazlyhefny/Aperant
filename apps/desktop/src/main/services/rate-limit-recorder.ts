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
import { rateLimitTypeFor } from '../claude-profile/rate-limit-manager';
import type { ClaudeRateLimitEvent } from '../../shared/types';
import type { ProviderAccount } from '../../shared/types/provider-account';

/** How long an account counts as exhausted when the error named no reset time. */
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 10 * 60_000;

/** At most this many events are kept per account. */
const MAX_EVENTS = 10;

function resetMs(event: ClaudeRateLimitEvent): number {
  const value = event.resetAt as unknown;
  if (typeof value === 'number') return value;
  const ms = new Date(value as string | Date).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Add a rate-limit event and drop events whose reset has passed, so the
 * array never grows without bound.
 */
export function withRateLimitEvent(
  events: ClaudeRateLimitEvent[] | undefined,
  resetAt: Date,
  now: number = Date.now()
): ClaudeRateLimitEvent[] {
  const event: ClaudeRateLimitEvent = {
    type: rateLimitTypeFor(resetAt, now),
    hitAt: new Date(now),
    resetAt,
    resetTimeString: resetAt.toISOString(),
  };
  return [event, ...(events ?? []).filter((e) => resetMs(e) > now)].slice(0, MAX_EVENTS);
}

/**
 * Record a rate limit for a provider account id (resetAt in ms, or null when
 * unknown) on the account and on its linked Claude profile.
 */
export async function recordAccountRateLimit(accountId: string, resetAt: number | null): Promise<void> {
  const now = Date.now();
  const reset = new Date(resetAt && resetAt > now ? resetAt : now + DEFAULT_RATE_LIMIT_COOLDOWN_MS);
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
