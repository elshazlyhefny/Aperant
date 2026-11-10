import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../codex-usage-fetcher', () => ({
  normalizeCodexResponse: vi.fn((_raw, profileId, profileName, profileEmail) => ({
    sessionPercent: 1,
    weeklyPercent: 2,
    profileId,
    profileName,
    profileEmail
  })),
  getCodexAccountId: vi.fn()
}));

import { getCodexAccountId, normalizeCodexResponse } from '../../codex-usage-fetcher';
import { getUsageEndpoint } from '../endpoints';
import { anthropicAdapter } from './anthropic';
import { openaiAdapter } from './openai';
import { normalizeQuotaLimitResponse } from './quota-limit';
import { getAllowedUsageDomains, getUsageProviderAdapter, USAGE_PROVIDER_ADAPTERS } from './registry';
import { zaiAdapter } from './zai';
import { zhipuAdapter } from './zhipu';

const ids = { profileId: 'p1', profileName: 'P1', profileEmail: 'a@b.c' };

describe('anthropic adapter', () => {
  it('builds beta headers', () => {
    expect(anthropicAdapter.buildHeaders('tok')).toEqual({
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
      'anthropic-version': '2023-06-01'
    });
  });

  it('normalizes nested format', () => {
    const raw = {
      five_hour: { utilization: 20, resets_at: 'a' },
      seven_day: { utilization: 50, resets_at: 'b' }
    };
    expect(anthropicAdapter.extractData(raw)).toBe(raw);
    const r = anthropicAdapter.normalize(raw, ids, raw);
    expect(r).toMatchObject({
      sessionPercent: 20,
      weeklyPercent: 50,
      sessionResetTimestamp: 'a',
      weeklyResetTimestamp: 'b',
      limitType: 'weekly',
      profileId: 'p1'
    });
  });

  it('normalizes legacy flat format', () => {
    const raw = { five_hour_utilization: 0.72, seven_day_utilization: 0.1 };
    const r = anthropicAdapter.normalize(raw, ids, raw);
    expect(r).toMatchObject({ sessionPercent: 72, weeklyPercent: 10, limitType: 'session' });
  });
});

describe('quota-limit adapters', () => {
  const data = {
    limits: [
      { type: 'TOKENS_LIMIT', percentage: 75.5, currentValue: 1, usage: 2 },
      { type: 'TIME_LIMIT', percentage: 45.2, currentValue: 3, usage: 4 }
    ]
  };

  it.each([
    ['zai', zaiAdapter],
    ['zhipu', zhipuAdapter]
  ] as const)('%s extracts data envelope and normalizes', (_name, adapter) => {
    expect(adapter.usagePath).toBe('/api/monitor/usage/quota/limit');
    expect(adapter.buildHeaders('x')).toEqual({});
    expect(adapter.extractData({ data })).toBe(data);
    const raw = { limits: [] };
    expect(adapter.extractData(raw)).toBe(raw);
    expect(adapter.normalize(data, ids, { data })).toMatchObject({
      sessionPercent: 76,
      weeklyPercent: 45,
      sessionUsageValue: 1,
      sessionUsageLimit: 2,
      weeklyUsageValue: 3,
      weeklyUsageLimit: 4
    });
  });

  it('returns null and warns when limits is missing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(normalizeQuotaLimitResponse({}, 'p', 'n', undefined, 'zai')).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('openai adapter', () => {
  afterEach(() => vi.mocked(getCodexAccountId).mockReset());

  it('adds ChatGPT-Account-Id when available', async () => {
    vi.mocked(getCodexAccountId).mockReturnValue('acct-1');
    expect(await openaiAdapter.buildHeaders('tok')).toEqual({ 'ChatGPT-Account-Id': 'acct-1' });
  });

  it('omits header when no account id or lookup throws', async () => {
    vi.mocked(getCodexAccountId).mockReturnValue(undefined);
    expect(await openaiAdapter.buildHeaders('tok')).toEqual({});
    vi.mocked(getCodexAccountId).mockImplementation(() => {
      throw new Error('bad');
    });
    expect(await openaiAdapter.buildHeaders('tok')).toEqual({});
  });

  it('delegates normalize to normalizeCodexResponse using raw', () => {
    const raw = { rate_limit: {} };
    openaiAdapter.normalize(raw, ids, raw);
    expect(normalizeCodexResponse).toHaveBeenCalledWith(raw, 'p1', 'P1', 'a@b.c');
  });
});

describe('registry', () => {
  it('derives the allowed domain set', () => {
    expect(getAllowedUsageDomains()).toEqual(
      new Set(['api.anthropic.com', 'api.z.ai', 'open.bigmodel.cn', 'chatgpt.com'])
    );
    expect(USAGE_PROVIDER_ADAPTERS).toHaveLength(4);
  });

  it('looks up adapters and returns undefined for unknown', () => {
    expect(getUsageProviderAdapter('zai')).toBe(zaiAdapter);
    expect(getUsageProviderAdapter('unknown')).toBeUndefined();
  });

  it('builds the expected endpoints', () => {
    expect(getUsageEndpoint('anthropic', 'https://api.anthropic.com')).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(getUsageEndpoint('openai', 'https://chatgpt.com/backend-api/codex')).toBe(
      'https://chatgpt.com/backend-api/wham/usage'
    );
    expect(getUsageEndpoint('zai', 'https://api.z.ai/api/anthropic')).toBe(
      'https://api.z.ai/api/monitor/usage/quota/limit'
    );
    expect(getUsageEndpoint('zhipu', 'https://open.bigmodel.cn/api/anthropic')).toBe(
      'https://open.bigmodel.cn/api/monitor/usage/quota/limit'
    );
    expect(getUsageEndpoint('unknown', 'https://example.com')).toBeNull();
  });
});
