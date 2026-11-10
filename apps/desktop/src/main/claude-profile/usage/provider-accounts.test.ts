import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProfileUsageSummary, ClaudeUsageSnapshot } from '../../../shared/types/agent';

const readSettings = vi.fn();
vi.mock('../../settings-utils', () => ({
  readSettingsFileAsync: (...args: unknown[]) => readSettings(...args),
}));
vi.mock('../../ai/auth/codex-oauth', () => ({
  ensureValidCodexToken: vi.fn().mockResolvedValue(null),
}));
vi.mock('../codex-usage-fetcher', () => ({
  fetchCodexUsage: vi.fn(),
  normalizeCodexResponse: vi.fn(),
  getCodexAccountId: vi.fn(),
}));

import { appendProviderAccountUsage, codexUsageSource, zaiUsageSource } from './provider-accounts';

const zaiAccount = { id: 'z1', provider: 'zai', name: 'Z One', authType: 'api-key', apiKey: 'raw-key' };
const codexAccount = { id: 'c1', provider: 'openai', name: 'Codex One', authType: 'oauth' };

function snapshot(over: Partial<ClaudeUsageSnapshot> = {}): ClaudeUsageSnapshot {
  return {
    profileId: 'z1',
    profileName: 'Z One',
    sessionPercent: 10,
    weeklyPercent: 20,
    needsReauthentication: true,
    fetchedAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  } as ClaudeUsageSnapshot;
}

describe('appendProviderAccountUsage', () => {
  const log = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns early when settings are missing', async () => {
    readSettings.mockResolvedValue(null);
    const all: ProfileUsageSummary[] = [];
    await appendProviderAccountUsage(all, zaiUsageSource, { currentUsage: null, log });
    expect(all).toEqual([]);
  });

  it('reuses currentUsage; Z.AI forces needsReauthentication=false, Codex copies it', async () => {
    readSettings.mockResolvedValue({ providerAccounts: [zaiAccount, codexAccount] });
    const zAll: ProfileUsageSummary[] = [];
    await appendProviderAccountUsage(zAll, zaiUsageSource, { currentUsage: snapshot(), log });
    expect(zAll[0]).toMatchObject({ profileId: 'z1', isActive: true, needsReauthentication: false });

    const cAll: ProfileUsageSummary[] = [];
    await appendProviderAccountUsage(cAll, codexUsageSource, {
      currentUsage: snapshot({ profileId: 'c1', sessionPercent: 96 }),
      log,
    });
    expect(cAll[0]).toMatchObject({ profileId: 'c1', needsReauthentication: true, isRateLimited: true });
  });

  it('skips accounts already present', async () => {
    readSettings.mockResolvedValue({ providerAccounts: [zaiAccount] });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const all = [{ profileId: 'z1' } as ProfileUsageSummary];
    await appendProviderAccountUsage(all, zaiUsageSource, { currentUsage: null, log });
    expect(all).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('adds a minimal entry when the inactive fetch fails', async () => {
    readSettings.mockResolvedValue({ providerAccounts: [codexAccount] });
    const all: ProfileUsageSummary[] = [];
    await appendProviderAccountUsage(all, codexUsageSource, { currentUsage: null, log });
    expect(all).toEqual([
      {
        profileId: 'c1',
        profileName: 'Codex One',
        sessionPercent: 0,
        weeklyPercent: 0,
        isAuthenticated: true,
        isRateLimited: false,
        availabilityScore: 100,
        isActive: false,
      },
    ]);
  });

  it('sends the raw Authorization header (no Bearer) for Z.AI', async () => {
    readSettings.mockResolvedValue({ providerAccounts: [zaiAccount] });
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal('fetch', fetchMock);
    const all: ProfileUsageSummary[] = [];
    await appendProviderAccountUsage(all, zaiUsageSource, { currentUsage: null, log });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.z.ai/api/monitor/usage/quota/limit',
      { headers: { Authorization: 'raw-key' } }
    );
    expect(all[0].availabilityScore).toBe(100);
  });

  it('logs when reading settings throws', async () => {
    readSettings.mockRejectedValue(new Error('boom'));
    await appendProviderAccountUsage([], codexUsageSource, { currentUsage: null, log });
    expect(log).toHaveBeenCalledWith('[UsageMonitor] Failed to append Codex accounts:', expect.any(Error));
  });
});
