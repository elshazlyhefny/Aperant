import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_SETTINGS } from '../constants/config';
import type { ProviderAccount } from '../types/provider-account';
import type { AppSettings } from '../types/settings';
import { toProviderAccountView, toProviderAccountViews, toRendererSettings } from './provider-account-view';

const SENTINEL = 'saved-provider-key-sentinel-179';
const ACCOUNT = {
  id: 'pa_test',
  provider: 'anthropic',
  name: 'Test account',
  authType: 'api-key',
  billingModel: 'pay-per-use',
  createdAt: 1,
  updatedAt: 2,
} satisfies ProviderAccount;

describe('provider account views', () => {
  it.each(['api-key', 'oauth'] as const)('omits the saved credential for %s accounts', (authType) => {
    const view = toProviderAccountView({ ...ACCOUNT, authType, apiKey: SENTINEL });

    expect(view).toStrictEqual({ ...ACCOUNT, authType, hasApiKey: true });
    expect(JSON.stringify(view)).not.toContain(SENTINEL);
  });

  it.each([undefined, '', '  \t\n'])('reports no saved key for %j and skips undefined fields', (apiKey) => {
    expect(toProviderAccountView({ ...ACCOUNT, apiKey, email: undefined })).toStrictEqual({
      ...ACCOUNT,
      hasApiKey: false,
    });
  });

  it('keeps allowlisted metadata and drops unknown fields', () => {
    const metadata = {
      ...ACCOUNT,
      email: 'test@example.com',
      baseUrl: 'https://api.example.com',
      region: 'us-east-1',
      claudeProfileId: 'test-profile',
      usage: {
        sessionUsagePercent: 10,
        sessionResetTime: '12:00',
        weeklyUsagePercent: 20,
        weeklyResetTime: 'Monday',
        lastUpdated: new Date(1),
      },
      rateLimitEvents: [{
        type: 'session',
        hitAt: new Date(1),
        resetAt: new Date(2),
        resetTimeString: '12:00',
      }],
      customModels: [{ id: 'test-model', label: 'Test model' }],
      keyStatus: 'valid',
      keyStatusAt: 0,
    } satisfies ProviderAccount;
    const account = { ...metadata, apiKey: SENTINEL, secretToken: 'unknown-secret' };

    expect(toProviderAccountViews([account])).toStrictEqual([{ ...metadata, hasApiKey: true }]);
  });

  it('returns an empty view list when no accounts are provided', () => {
    expect(toProviderAccountViews(undefined)).toStrictEqual([]);
  });
});

describe('toRendererSettings', () => {
  it('returns a shallow settings copy with safe accounts without modifying the input', () => {
    const settings: AppSettings = {
      ...DEFAULT_APP_SETTINGS,
      providerAccounts: [{ ...ACCOUNT, apiKey: SENTINEL }],
    };
    const view = toRendererSettings(settings);

    expect(view).not.toBe(settings);
    expect(view).toStrictEqual({
      ...DEFAULT_APP_SETTINGS,
      providerAccounts: [{ ...ACCOUNT, hasApiKey: true }],
    });
    expect(view.notifications).toBe(settings.notifications);
    expect(JSON.stringify(view)).not.toContain(SENTINEL);
    expect(settings).toStrictEqual({
      ...DEFAULT_APP_SETTINGS,
      providerAccounts: [{ ...ACCOUNT, apiKey: SENTINEL }],
    });
  });

  it('keeps providerAccounts undefined when settings do not define it', () => {
    expect(toRendererSettings(DEFAULT_APP_SETTINGS).providerAccounts).toBeUndefined();
  });
});
