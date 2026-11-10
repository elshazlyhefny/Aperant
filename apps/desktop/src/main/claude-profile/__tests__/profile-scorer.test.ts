import { describe, it, expect, vi } from 'vitest';
import type { ClaudeProfile, ClaudeAutoSwitchSettings, APIProfile } from '../../../shared/types';
import type { ProviderAccount } from '../../../shared/types/provider-account';

vi.mock('../rate-limit-manager', () => ({
  isProfileRateLimited: vi.fn(() => ({ limited: false }))
}));
vi.mock('../profile-utils', () => ({
  isProfileAuthenticated: vi.fn(() => true)
}));

import { getBestAvailableUnifiedAccount, scoreProviderAccount } from '../profile-scorer';

const settings = { enabled: true, sessionThreshold: 95, weeklyThreshold: 99 } as ClaudeAutoSwitchSettings;

function api(id: string, keyStatus?: APIProfile['keyStatus']): APIProfile {
  return { id, name: id, baseUrl: 'https://x.test', apiKey: 'k', keyStatus } as APIProfile;
}
function oauth(id: string): ClaudeProfile {
  return { id, name: id } as ClaudeProfile;
}
function provider(over: Partial<ProviderAccount>): ProviderAccount {
  return {
    id: 'p', provider: 'anthropic', name: 'p', authType: 'api-key',
    billingModel: 'pay-per-use', createdAt: 0, updatedAt: 0, ...over
  } as ProviderAccount;
}

describe('getBestAvailableUnifiedAccount key status', () => {
  it('never selects a rejected API profile, even when it is the only candidate', () => {
    expect(getBestAvailableUnifiedAccount([], [api('a', 'rejected')], settings)).toBeNull();
  });

  it('skips rejected in favour of a lower-priority unverified one', () => {
    const r = getBestAvailableUnifiedAccount([], [api('a', 'rejected'), api('b', 'unverified')], settings, {
      priorityOrder: ['api-a', 'api-b']
    });
    expect(r?.id).toBe('api-b');
  });

  it('failover prefers valid over unverified even when unverified has higher priority', () => {
    const r = getBestAvailableUnifiedAccount([], [api('u', 'unverified'), api('v', 'valid'), api('cur')], settings, {
      excludeAccountId: 'api-cur',
      priorityOrder: ['api-u', 'api-v']
    });
    expect(r?.id).toBe('api-v');
  });

  it('without exclude id keeps priority order', () => {
    const r = getBestAvailableUnifiedAccount([], [api('u', 'unverified'), api('v', 'valid')], settings, {
      priorityOrder: ['api-u', 'api-v']
    });
    expect(r?.id).toBe('api-u');
  });

  it('failover ranks unverified API behind OAuth regardless of priority', () => {
    const r = getBestAvailableUnifiedAccount([oauth('o')], [api('u', 'unverified'), api('cur')], settings, {
      excludeAccountId: 'api-cur',
      priorityOrder: ['api-u', 'oauth-o']
    });
    expect(r?.id).toBe('oauth-o');
  });

  it('leaves OAuth accounts unaffected', () => {
    const r = getBestAvailableUnifiedAccount([oauth('o1'), oauth('o2')], [], settings, {
      priorityOrder: ['oauth-o2', 'oauth-o1']
    });
    expect(r?.id).toBe('oauth-o2');
  });

  it('treats profiles with no keyStatus as unverified', () => {
    const r = getBestAvailableUnifiedAccount([], [api('none'), api('v', 'valid')], settings, {
      excludeAccountId: 'api-x',
      priorityOrder: ['api-none', 'api-v']
    });
    expect(r?.id).toBe('api-v');
    const solo = getBestAvailableUnifiedAccount([], [api('none')], settings);
    expect(solo?.id).toBe('api-none');
  });
});

describe('scoreProviderAccount key status', () => {
  it('rejected -> unavailable', () => {
    const r = scoreProviderAccount(provider({ keyStatus: 'rejected' }), settings);
    expect(r.available).toBe(false);
    expect(r.score).toBeLessThanOrEqual(0);
  });

  it('unverified and valid -> available, valid scores higher', () => {
    const u = scoreProviderAccount(provider({ keyStatus: 'unverified' }), settings);
    const v = scoreProviderAccount(provider({ keyStatus: 'valid' }), settings);
    const none = scoreProviderAccount(provider({}), settings);
    expect(u.available).toBe(true);
    expect(v.available).toBe(true);
    expect(v.score).toBeGreaterThan(u.score);
    expect(none.score).toBe(u.score);
  });
});
