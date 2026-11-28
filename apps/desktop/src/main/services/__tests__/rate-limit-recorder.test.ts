/**
 * zeenha fork: rate limits are recorded on the provider account and its linked
 * Claude profile, and scoring then treats the account as unavailable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSettings, recordProfileEvent } = vi.hoisted(() => ({
  mockSettings: { current: {} as Record<string, unknown> },
  recordProfileEvent: vi.fn(),
}));

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/mock') } }));
vi.mock('../../settings-utils', () => ({
  updateSettingsFile: vi.fn(async (mutator: (s: Record<string, unknown>) => unknown) => mutator(mockSettings.current)),
}));
vi.mock('../../claude-profile-manager', () => ({
  getClaudeProfileManager: () => ({ recordRateLimitEvent: recordProfileEvent }),
}));

import { DEFAULT_RATE_LIMIT_COOLDOWN_MS, recordAccountRateLimit, withRateLimitEvent } from '../rate-limit-recorder';
import { scoreProviderAccount } from '../../claude-profile/profile-scorer';
import type { ProviderAccount } from '../../../shared/types/provider-account';
import type { ClaudeAutoSwitchSettings } from '../../../shared/types';

const autoSwitch = { sessionThreshold: 95, weeklyThreshold: 99 } as ClaudeAutoSwitchSettings;

function account(extra: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    id: 'pa_1', provider: 'anthropic', name: 'A', authType: 'oauth', billingModel: 'subscription',
    createdAt: 1, updatedAt: 1, ...extra,
  };
}

describe('recordAccountRateLimit', () => {
  beforeEach(() => {
    recordProfileEvent.mockClear();
  });

  it('records the reset on the account and its Claude profile, making the account unavailable', async () => {
    const resetAt = Date.now() + 3_600_000;
    mockSettings.current = { providerAccounts: [account({ claudeProfileId: 'profile-1' })] };

    await recordAccountRateLimit('pa_1', resetAt);

    const saved = (mockSettings.current.providerAccounts as ProviderAccount[])[0];
    expect(saved.rateLimitEvents).toHaveLength(1);
    expect(new Date(saved.rateLimitEvents?.[0].resetAt as Date).getTime()).toBe(resetAt);
    expect(recordProfileEvent).toHaveBeenCalledWith('profile-1', new Date(resetAt).toISOString(), new Date(resetAt));
    // Survives a JSON round trip like settings.json
    const persisted = JSON.parse(JSON.stringify(saved)) as ProviderAccount;
    expect(scoreProviderAccount(persisted, autoSwitch)).toMatchObject({ available: false, reason: 'rate limited' });
  });

  it('uses a short default cooldown when the reset time is unknown', async () => {
    const before = Date.now();
    mockSettings.current = { providerAccounts: [account()] };
    await recordAccountRateLimit('pa_1', null);
    const saved = (mockSettings.current.providerAccounts as ProviderAccount[])[0];
    const reset = new Date(saved.rateLimitEvents?.[0].resetAt as Date).getTime();
    expect(reset).toBeGreaterThanOrEqual(before + DEFAULT_RATE_LIMIT_COOLDOWN_MS);
    expect(reset).toBeLessThanOrEqual(Date.now() + DEFAULT_RATE_LIMIT_COOLDOWN_MS);
    expect(recordProfileEvent).not.toHaveBeenCalled();
  });

  it('ignores an unknown account and never throws', async () => {
    mockSettings.current = { providerAccounts: [account()] };
    await expect(recordAccountRateLimit('missing', null)).resolves.toBeUndefined();
    expect((mockSettings.current.providerAccounts as ProviderAccount[])[0].rateLimitEvents).toBeUndefined();
  });
});

describe('withRateLimitEvent', () => {
  it('drops events whose reset has passed and caps the list', () => {
    const now = 1_000_000;
    const expired = { type: 'session' as const, hitAt: new Date(0), resetAt: new Date(now - 1), resetTimeString: '' };
    const active = Array.from({ length: 12 }, (_, i) => ({
      type: 'session' as const, hitAt: new Date(0), resetAt: new Date(now + 1000 + i), resetTimeString: '',
    }));
    const events = withRateLimitEvent([expired, ...active], new Date(now + 60_000), now);
    expect(events).toHaveLength(10);
    expect(events[0].resetAt).toEqual(new Date(now + 60_000));
    expect(events).not.toContainEqual(expired);
  });

  it('classifies a reset more than a day away as weekly', () => {
    const now = 1_000_000;
    expect(withRateLimitEvent([], new Date(now + 2 * 86_400_000), now)[0].type).toBe('weekly');
    expect(withRateLimitEvent([], new Date(now + 3_600_000), now)[0].type).toBe('session');
  });
});
