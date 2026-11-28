/**
 * zeenha fork: the desktop capacity check the task queue runs before promoting.
 */
import { describe, expect, it } from 'vitest';
import type { ClaudeAutoSwitchSettings, ProfileUsageSummary, Task } from '../../shared/types';
import type { ProviderAccount } from '../../shared/types/provider-account';
import { checkTaskCapacity, evaluateCapacity, type CapacityInputs } from '../queue-capacity';

const NOW = 1_800_000_000_000;
const autoSwitch = { sessionThreshold: 95, weeklyThreshold: 99 } as ClaudeAutoSwitchSettings;

function account(id: string, extra: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    id, provider: 'anthropic', name: id, authType: 'oauth', billingModel: 'subscription',
    createdAt: 1, updatedAt: 1, ...extra,
  };
}

const limitedUntil = (resetAt: number) => ({
  rateLimitEvents: [{ type: 'session' as const, hitAt: new Date(NOW - 1000), resetAt: new Date(resetAt), resetTimeString: '' }],
});

function task(metadata?: Record<string, unknown>): Task {
  return { id: 't1', metadata } as unknown as Task;
}

function inputs(accounts: ProviderAccount[], extra: Partial<CapacityInputs> = {}): CapacityInputs {
  return { accounts, autoSwitch, profileLimit: () => ({ limited: false }), usage: [], now: NOW, ...extra };
}

describe('evaluateCapacity', () => {
  it('is ok while any account is usable', () => {
    const result = evaluateCapacity(task(), inputs([account('a', limitedUntil(NOW + 1000)), account('b')]));
    expect(result).toEqual({ ok: true });
  });

  it('blocks until the earliest reset when every account is rate limited', () => {
    const result = evaluateCapacity(task(), inputs([
      account('a', limitedUntil(NOW + 60_000)),
      account('b', limitedUntil(NOW + 30_000)),
    ]));
    expect(result).toEqual({ ok: false, reason: 'All accounts are rate limited', retryAt: NOW + 30_000 });
  });

  it('uses the linked Claude profile and cached usage resets', () => {
    const usage = [{ profileId: 'profile-b', isRateLimited: true, rateLimitType: 'weekly', sessionPercent: 10, weeklyPercent: 100,
      weeklyResetTimestamp: new Date(NOW + 90_000).toISOString() } as ProfileUsageSummary];
    const result = evaluateCapacity(task(), inputs(
      [account('a', { claudeProfileId: 'profile-a' }), account('b', { claudeProfileId: 'profile-b' })],
      {
        usage,
        profileLimit: (id) => (id === 'profile-a' ? { limited: true, resetAt: new Date(NOW + 120_000) } : { limited: false }),
      }
    ));
    expect(result).toEqual({ ok: false, reason: 'All accounts are rate limited', retryAt: NOW + 90_000 });
  });

  it('ignores a stale usage summary whose reset has passed', () => {
    const usage = [{ profileId: 'a', isRateLimited: true, rateLimitType: 'session', sessionPercent: 100, weeklyPercent: 0,
      sessionResetTimestamp: new Date(NOW - 1000).toISOString() } as ProfileUsageSummary];
    expect(evaluateCapacity(task(), inputs([account('a')], { usage }))).toEqual({ ok: true });
  });

  it('only looks at the providers a routed task uses', () => {
    const accounts = [account('claude', limitedUntil(NOW + 60_000)), account('codex', { provider: 'openai' })];
    // Routed to Codex only: the exhausted Claude account does not matter
    expect(evaluateCapacity(task({ phaseProviders: { planning: 'openai', coding: 'openai' } }), inputs(accounts))).toEqual({ ok: true });
    // Needs Claude for planning: blocked
    expect(evaluateCapacity(task({ phaseProviders: { planning: 'anthropic', coding: 'openai' } }), inputs(accounts)))
      .toEqual({ ok: false, reason: 'All anthropic accounts are rate limited', retryAt: NOW + 60_000 });
  });

  it('does not block on pay-per-use keys or rejected keys alone', () => {
    const payg = account('k', { authType: 'api-key', billingModel: 'pay-per-use', ...limitedUntil(NOW + 60_000) });
    expect(evaluateCapacity(task(), inputs([payg]))).toEqual({ ok: true });
    const rejected = account('r', { authType: 'api-key', billingModel: 'pay-per-use', keyStatus: 'rejected' });
    expect(evaluateCapacity(task(), inputs([rejected]))).toEqual({ ok: true });
  });

  it('has no retry time when no reset is known', () => {
    const result = evaluateCapacity(task(), inputs([account('a', { claudeProfileId: 'p' })], {
      profileLimit: () => ({ limited: true }),
    }));
    expect(result).toEqual({ ok: false, reason: 'All accounts are rate limited' });
  });
});

describe('checkTaskCapacity', () => {
  it('fails open when loading inputs throws', async () => {
    await expect(checkTaskCapacity(task(), () => { throw new Error('boom'); })).resolves.toEqual({ ok: true });
  });
});
