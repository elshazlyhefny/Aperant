/**
 * Tests for usage/active-profile-resolver.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetProfile = vi.fn();
const mockGetActiveProfile = vi.fn();
vi.mock('../../claude-profile-manager', () => ({
  getClaudeProfileManager: vi.fn(() => ({
    getProfile: mockGetProfile,
    getActiveProfile: mockGetActiveProfile
  }))
}));

const mockLoadProfilesFile = vi.fn(async () => ({
  profiles: [] as Array<{ id: string; name: string; baseUrl: string; apiKey: string }>,
  activeProfileId: null as string | null,
  version: 1
}));
vi.mock('../../services/profile/api-profile-store', () => ({
  loadProfilesFile: () => mockLoadProfilesFile()
}));

const mockGetCredentialsFromKeychain = vi.fn(() => ({ token: 'keychain-token', email: 'kc@example.com' }));
vi.mock('../credential-utils', () => ({
  getCredentialsFromKeychain: () => mockGetCredentialsFromKeychain()
}));

const mockEnsureValidToken = vi.fn();
vi.mock('../token-refresh', () => ({
  ensureValidToken: (...args: unknown[]) => mockEnsureValidToken(...args)
}));

const mockEnsureValidCodexToken = vi.fn();
vi.mock('../../ai/auth/codex-oauth', () => ({
  ensureValidCodexToken: () => mockEnsureValidCodexToken()
}));

const mockReadSettings = vi.fn();
vi.mock('../../settings-utils', () => ({
  readSettingsFileAsync: () => mockReadSettings(),
  updateSettingsFile: async (mutator: (s: unknown) => unknown) => mutator((await mockReadSettings()) ?? {})
}));

import { resolveActiveProfile } from './active-profile-resolver';

function makeDeps() {
  return {
    needsReauthProfiles: new Set<string>(),
    log: { debugLog: vi.fn(), traceLog: vi.fn() }
  };
}

function settingsWith(account: Record<string, unknown>) {
  return { providerAccounts: [account], globalPriorityOrder: [account.id] };
}

describe('resolveActiveProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadProfilesFile.mockResolvedValue({ profiles: [], activeProfileId: null, version: 1 });
  });

  it('resolves Anthropic OAuth accounts', async () => {
    mockReadSettings.mockResolvedValue(
      settingsWith({ id: 'a1', name: 'Acc', provider: 'anthropic', authType: 'oauth', claudeProfileId: 'p1', email: 'x@y.z' })
    );
    mockGetProfile.mockReturnValue({ id: 'p1', configDir: '/tmp/cfg' });
    mockEnsureValidToken.mockResolvedValue({ token: 'oauth-token' });
    const deps = makeDeps();
    deps.needsReauthProfiles.add('a1');

    const result = await resolveActiveProfile(deps);

    expect(result).toEqual({
      profileId: 'a1',
      profileName: 'Acc',
      profileEmail: 'x@y.z',
      isAPIProfile: false,
      baseUrl: 'https://api.anthropic.com',
      credential: 'oauth-token'
    });
    expect(deps.needsReauthProfiles.has('a1')).toBe(false);
  });

  it('marks Anthropic OAuth account as needing reauth when no token is available', async () => {
    mockReadSettings.mockResolvedValue(
      settingsWith({ id: 'a1', name: 'Acc', provider: 'anthropic', authType: 'oauth', claudeProfileId: 'p1', email: 'x@y.z' })
    );
    mockGetProfile.mockReturnValue({ id: 'p1', configDir: '/tmp/cfg' });
    mockEnsureValidToken.mockResolvedValue({ token: null, error: 'bad', errorCode: 'invalid_grant' });
    mockGetCredentialsFromKeychain.mockReturnValueOnce({ token: null as unknown as string, email: 'kc@example.com' });
    const deps = makeDeps();

    const result = await resolveActiveProfile(deps);

    expect(result?.credential).toBeUndefined();
    expect(deps.needsReauthProfiles.has('a1')).toBe(true);
  });

  it('resolves Anthropic API key accounts', async () => {
    mockReadSettings.mockResolvedValue(
      settingsWith({ id: 'k1', name: 'Key', provider: 'anthropic', authType: 'api-key', apiKey: 'sk-1', baseUrl: 'https://custom' })
    );

    const result = await resolveActiveProfile(makeDeps());

    expect(result).toMatchObject({
      profileId: 'k1',
      isAPIProfile: true,
      baseUrl: 'https://custom',
      credential: 'sk-1'
    });
  });

  it('resolves OpenAI/Codex OAuth accounts', async () => {
    mockReadSettings.mockResolvedValue(settingsWith({ id: 'o1', name: 'Codex', provider: 'openai', authType: 'oauth' }));
    mockEnsureValidCodexToken.mockResolvedValue('codex-token');

    const result = await resolveActiveProfile(makeDeps());

    expect(result).toMatchObject({
      profileId: 'o1',
      isAPIProfile: false,
      baseUrl: 'https://chatgpt.com',
      credential: 'codex-token'
    });
  });

  it('resolves Z.AI accounts and returns null without an apiKey', async () => {
    mockReadSettings.mockResolvedValue(settingsWith({ id: 'z1', name: 'Z', provider: 'zai', authType: 'api-key', apiKey: 'zk' }));
    expect(await resolveActiveProfile(makeDeps())).toMatchObject({
      profileId: 'z1',
      isAPIProfile: true,
      baseUrl: 'https://api.z.ai',
      credential: 'zk'
    });

    mockReadSettings.mockResolvedValue(settingsWith({ id: 'z2', name: 'Z', provider: 'zai', authType: 'api-key' }));
    expect(await resolveActiveProfile(makeDeps())).toBeNull();
  });

  it('resolves OpenRouter accounts with default and custom baseUrl, null without apiKey', async () => {
    mockReadSettings.mockResolvedValue(settingsWith({ id: 'r1', name: 'R', provider: 'openrouter', authType: 'api-key', apiKey: 'rk' }));
    expect(await resolveActiveProfile(makeDeps())).toMatchObject({
      profileId: 'r1',
      isAPIProfile: true,
      baseUrl: 'https://openrouter.ai/api',
      credential: 'rk'
    });

    mockReadSettings.mockResolvedValue(settingsWith({ id: 'r3', name: 'R', provider: 'openrouter', authType: 'api-key', apiKey: 'rk', baseUrl: 'https://proxy.example/api' }));
    expect(await resolveActiveProfile(makeDeps())).toMatchObject({ baseUrl: 'https://proxy.example/api' });

    mockReadSettings.mockResolvedValue(settingsWith({ id: 'r2', name: 'R', provider: 'openrouter', authType: 'api-key' }));
    expect(await resolveActiveProfile(makeDeps())).toBeNull();
  });

  it('returns null for unsupported providers', async () => {
    mockReadSettings.mockResolvedValue(settingsWith({ id: 'g1', name: 'G', provider: 'google', authType: 'api-key', apiKey: 'g' }));
    expect(await resolveActiveProfile(makeDeps())).toBeNull();
  });

  it('falls back to the legacy API profile when globalPriorityOrder is empty', async () => {
    mockReadSettings.mockResolvedValue({ providerAccounts: [], globalPriorityOrder: [] });
    mockLoadProfilesFile.mockResolvedValue({
      profiles: [{ id: 'legacy', name: 'Legacy', baseUrl: 'https://legacy', apiKey: 'lk' }],
      activeProfileId: 'legacy',
      version: 1
    });

    const result = await resolveActiveProfile(makeDeps());

    expect(result).toEqual({
      profileId: 'legacy',
      profileName: 'Legacy',
      isAPIProfile: true,
      baseUrl: 'https://legacy',
      credential: 'lk'
    });
  });
});
