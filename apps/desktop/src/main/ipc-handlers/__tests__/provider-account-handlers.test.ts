import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const state = vi.hoisted(() => ({
  userData: '',
  encryptionAvailable: true,
  loadProfilesFile: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => state.userData },
  safeStorage: {
    isEncryptionAvailable: () => state.encryptionAvailable,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => Buffer.from(value, 'utf-8'),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
      state.handlers.set(channel, fn);
    },
  },
}));

const manager = vi.hoisted(() => ({ setAccountPriorityOrder: vi.fn() }));
vi.mock('../../claude-profile-manager', () => ({
  getClaudeProfileManager: () => manager,
}));

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }));
vi.mock('../../app-logger', () => ({ appLog: { warn: vi.fn() } }));
vi.mock('../../app-updater', () => ({ setUpdateChannel: vi.fn(), setUpdateChannelWithDowngradeCheck: vi.fn() }));
vi.mock('../../cli-tool-manager', () => ({
  configureTools: vi.fn(), getToolPath: vi.fn(), getToolInfo: vi.fn(),
  isPathFromWrongPlatform: vi.fn(), preWarmToolCache: vi.fn(async () => undefined),
}));
vi.mock('../context/memory-service-factory', () => ({ resetMemoryService: vi.fn() }));
vi.mock('../../services/profile', () => ({ loadProfilesFile: state.loadProfilesFile }));

import { registerProviderAccountHandlers } from '../provider-account-handlers';
import { registerSettingsHandlers } from '../settings-handlers';
import { clearSecretCacheForTests, decryptSecret } from '../../secure-storage/secret-storage';
import { clearSessionApiKeys, getSessionApiKey } from '../../secure-storage/session-credentials';
import { isSecretEnvelope } from '../../../shared/utils/secret-envelope';
import { IPC_CHANNELS } from '../../../shared/constants';

type Res = { success: boolean; error?: string; data?: any };

function call(channel: string, ...args: unknown[]): Promise<Res> {
  const fn = state.handlers.get(channel);
  if (!fn) throw new Error(`No handler for ${channel}`);
  return fn({}, ...args) as Promise<Res>;
}

const settingsPath = () => path.join(state.userData, 'settings.json');
const readSettings = () => JSON.parse(readFileSync(settingsPath(), 'utf-8'));
// Saved keys are encrypted at rest; decode the stored value for comparison.
const storedKey = (account: { apiKey?: string }) =>
  isSecretEnvelope(account.apiKey) ? decryptSecret(account.apiKey) : account.apiKey;
const newAccount = (email: string, name = email) =>
  ({ provider: 'openai', name, email, authType: 'api-key', billingModel: 'pay-per-use' }) as const;

beforeAll(() => {
  registerProviderAccountHandlers();
  registerSettingsHandlers({ configure: vi.fn() } as never, () => null);
});

beforeEach(() => {
  if (state.userData) rmSync(state.userData, { recursive: true, force: true });
  state.userData = mkdtempSync(path.join(tmpdir(), 'provider-accounts-'));
  state.encryptionAvailable = true;
  state.loadProfilesFile.mockReset().mockResolvedValue({ profiles: [] });
  clearSessionApiKeys();
  clearSecretCacheForTests();
  manager.setAccountPriorityOrder.mockClear();
});

afterAll(() => {
  clearSessionApiKeys();
  clearSecretCacheForTests();
  rmSync(state.userData, { recursive: true, force: true });
});

describe('provider account handlers', () => {
  describe('IPC contract: saved keys never leave main', () => {
    const SENTINEL = 'saved-provider-key-fixture';
    const apiKeyAccount = {
      ...newAccount('api@x.com', 'API key account'),
      id: 'pa_key',
      apiKey: SENTINEL,
      baseUrl: 'https://provider.example',
      createdAt: 100,
      updatedAt: 200,
      keyStatus: 'valid',
      keyStatusAt: 200,
    };

    beforeEach(() => {
      const oauthAccount = {
        ...apiKeyAccount,
        id: 'pa_oauth',
        name: 'OAuth account',
        provider: 'anthropic',
        authType: 'oauth',
        billingModel: 'subscription',
        email: 'oauth@x.com',
      };
      writeFileSync(settingsPath(), JSON.stringify({ providerAccounts: [apiKeyAccount, oauthAccount] }));
    });

    it('GET returns only views for both API-key and OAuth accounts', async () => {
      const res = await call(IPC_CHANNELS.PROVIDER_ACCOUNTS_GET);
      expect(res.success).toBe(true);
      expect(JSON.stringify(res)).not.toContain(SENTINEL);
      expect(res.data.accounts).toMatchObject([
        { id: apiKeyAccount.id, authType: 'api-key', hasApiKey: true },
        { id: 'pa_oauth', authType: 'oauth', hasApiKey: true },
      ]);
    });

    it('SAVE persists the key but returns only a derived hasApiKey flag', async () => {
      const res = await call(IPC_CHANNELS.PROVIDER_ACCOUNTS_SAVE, {
        ...newAccount('saved@x.com'),
        apiKey: SENTINEL,
        hasApiKey: false,
      });
      expect(res.success).toBe(true);
      expect(res.data).toMatchObject({ email: 'saved@x.com', hasApiKey: true });
      expect(JSON.stringify(res)).not.toContain(SENTINEL);
      const stored = readSettings().providerAccounts[2];
      expect(stored).toMatchObject({ id: res.data.id });
      expect(storedKey(stored)).toBe(SENTINEL);
      expect(stored).not.toHaveProperty('hasApiKey');
    });

    it.each([
      ['omitted', {}],
      ['undefined', { apiKey: undefined }],
      ['null', { apiKey: null }],
      ['non-string', { apiKey: 123 }],
      ['empty', { apiKey: '' }],
      ['whitespace', { apiKey: '   ' }],
      ['unchanged after trimming', { apiKey: ` ${SENTINEL} ` }],
    ] as const)('UPDATE keeps the key and verification status when apiKey is %s', async (_case, updates) => {
      const res = await call(IPC_CHANNELS.PROVIDER_ACCOUNTS_UPDATE, apiKeyAccount.id, {
        ...updates,
        name: 'Renamed',
        hasApiKey: false,
      });
      expect(res.success).toBe(true);
      expect(res.data).toMatchObject({ name: 'Renamed', hasApiKey: true, keyStatus: 'valid', keyStatusAt: 200 });
      expect(JSON.stringify(res)).not.toContain(SENTINEL);
      const [stored] = readSettings().providerAccounts;
      expect(stored).toMatchObject({ name: 'Renamed', keyStatus: 'valid', keyStatusAt: 200 });
      expect(storedKey(stored)).toBe(SENTINEL);
      expect(stored).not.toHaveProperty('hasApiKey');
    });

    it('UPDATE trims and stores a replacement key, resets status, and returns neither key', async () => {
      const replacement = 'replacement-provider-key-fixture';
      const res = await call(IPC_CHANNELS.PROVIDER_ACCOUNTS_UPDATE, apiKeyAccount.id, {
        apiKey: `  ${replacement}  `,
      });
      expect(res.success).toBe(true);
      expect(res.data.hasApiKey).toBe(true);
      expect(res.data).not.toHaveProperty('keyStatus');
      expect(res.data).not.toHaveProperty('keyStatusAt');
      const serialized = JSON.stringify(res);
      expect(serialized).not.toContain(SENTINEL);
      expect(serialized).not.toContain(replacement);
      const [stored] = readSettings().providerAccounts;
      expect(storedKey(stored)).toBe(replacement);
      expect(stored).not.toHaveProperty('keyStatus');
      expect(stored).not.toHaveProperty('keyStatusAt');
    });

    it('UPDATE resets verification when the endpoint changes without replacing the key', async () => {
      const baseUrl = 'https://updated.example';
      const res = await call(IPC_CHANNELS.PROVIDER_ACCOUNTS_UPDATE, apiKeyAccount.id, { baseUrl, apiKey: '' });
      expect(res.success).toBe(true);
      expect(res.data).toMatchObject({ baseUrl, hasApiKey: true });
      expect(JSON.stringify(res)).not.toContain(SENTINEL);
      const [stored] = readSettings().providerAccounts;
      expect(stored).toMatchObject({ baseUrl });
      expect(storedKey(stored)).toBe(SENTINEL);
      expect(stored).not.toHaveProperty('keyStatus');
      expect(stored).not.toHaveProperty('keyStatusAt');
    });
  });

  describe('corrupt settings.json', () => {
    const CORRUPT = '{ broken';

    it('every mutating handler fails and leaves the file bytes unchanged', async () => {
      writeFileSync(settingsPath(), CORRUPT);
      const calls: Array<[string, unknown[]]> = [
        [IPC_CHANNELS.PROVIDER_ACCOUNTS_SAVE, [newAccount('a@x.com')]],
        [IPC_CHANNELS.PROVIDER_ACCOUNTS_UPDATE, ['pa_1', { name: 'n' }]],
        [IPC_CHANNELS.PROVIDER_ACCOUNTS_DELETE, ['pa_1']],
        [IPC_CHANNELS.PROVIDER_ACCOUNTS_SET_QUEUE_ORDER, [['a', 'b']]],
        [IPC_CHANNELS.PROVIDER_ACCOUNTS_SET_CROSS_PROVIDER_QUEUE_ORDER, [['a', 'b']]],
        [IPC_CHANNELS.MODEL_OVERRIDES_SAVE, [{}]],
      ];
      for (const [channel, args] of calls) {
        const res = await call(channel, ...args);
        expect(res.success, channel).toBe(false);
        expect(res.error, channel).toBeTruthy();
        expect(readFileSync(settingsPath(), 'utf-8'), channel).toBe(CORRUPT);
      }
      expect(manager.setAccountPriorityOrder).not.toHaveBeenCalled();
    });

    it('GET returns [] for a corrupt file', async () => {
      writeFileSync(settingsPath(), CORRUPT);
      const res = await call(IPC_CHANNELS.PROVIDER_ACCOUNTS_GET);
      expect(res).toEqual({ success: true, data: { accounts: [] } });
      expect(readFileSync(settingsPath(), 'utf-8')).toBe(CORRUPT);
    });
  });

  describe('credential storage', () => {
    const apiKey = 'test-provider-key';
    const account = { ...newAccount('test@example.com'), apiKey };

    it('writes only an encrypted envelope and never returns the key over IPC', async () => {
      const saved = await call(IPC_CHANNELS.PROVIDER_ACCOUNTS_SAVE, account);
      expect(saved.success).toBe(true);
      expect(readFileSync(settingsPath(), 'utf-8')).not.toContain(apiKey);
      expect(isSecretEnvelope(readSettings().providerAccounts[0].apiKey)).toBe(true);
      expect((await call(IPC_CHANNELS.PROVIDER_ACCOUNTS_GET)).data.accounts).toEqual([saved.data]);
      expect(saved.data).toMatchObject({ hasApiKey: true });
      expect(JSON.stringify(saved)).not.toContain(apiKey);
      expect(storedKey(readSettings().providerAccounts[0])).toBe(apiKey);
    });

    it('refuses to save a new key without secure storage and leaves the file untouched', async () => {
      state.encryptionAvailable = false;
      const before = '{"theme":"dark"}';
      writeFileSync(settingsPath(), before);

      expect(await call(IPC_CHANNELS.PROVIDER_ACCOUNTS_SAVE, account)).toEqual({
        success: false, error: 'SECURE_STORAGE_UNAVAILABLE',
      });
      expect(readFileSync(settingsPath(), 'utf-8')).toBe(before);
    });

    it('uses a session-only key without secure storage and forgets it on delete', async () => {
      state.encryptionAvailable = false;
      const saved = await call(IPC_CHANNELS.PROVIDER_ACCOUNTS_SAVE, { ...account, apiKeySessionOnly: true });
      expect(saved.success).toBe(true);
      expect(readSettings().providerAccounts[0]).toMatchObject({ id: saved.data.id, apiKeySessionOnly: true });
      expect(readSettings().providerAccounts[0]).not.toHaveProperty('apiKey');
      expect((await call(IPC_CHANNELS.PROVIDER_ACCOUNTS_GET)).data.accounts).toEqual([saved.data]);
      expect(getSessionApiKey(saved.data.id)).toBe(apiKey);
      expect(saved.data).toMatchObject({ apiKeySessionOnly: true, hasApiKey: true });
      expect(JSON.stringify(saved)).not.toContain(apiKey);

      expect(await call(IPC_CHANNELS.PROVIDER_ACCOUNTS_DELETE, saved.data.id)).toEqual({ success: true });
      expect(getSessionApiKey(saved.data.id)).toBeUndefined();
    });

    it.each([undefined, ''])('drops the session-only flag for an empty key (%s)', async (emptyKey) => {
      state.encryptionAvailable = false;
      const saved = await call(IPC_CHANNELS.PROVIDER_ACCOUNTS_SAVE, { ...account, apiKey: emptyKey, apiKeySessionOnly: true });
      expect(saved.success).toBe(true);
      expect(saved.data).not.toHaveProperty('apiKeySessionOnly');
      expect(readSettings().providerAccounts[0]).not.toHaveProperty('apiKeySessionOnly');
    });

    it('refuses an insecure update without changing the disk or session key, but allows an explicit session-only update', async () => {
      state.encryptionAvailable = false;
      const saved = await call(IPC_CHANNELS.PROVIDER_ACCOUNTS_SAVE, { ...account, apiKeySessionOnly: true });
      const before = readFileSync(settingsPath(), 'utf-8');
      const replacementKey = 'updated-provider-key';

      expect(await call(IPC_CHANNELS.PROVIDER_ACCOUNTS_UPDATE, saved.data.id, { apiKey: replacementKey })).toEqual({
        success: false, error: 'SECURE_STORAGE_UNAVAILABLE',
      });
      expect(readFileSync(settingsPath(), 'utf-8')).toBe(before);
      expect(getSessionApiKey(saved.data.id)).toBe(apiKey);

      const updated = await call(IPC_CHANNELS.PROVIDER_ACCOUNTS_UPDATE, saved.data.id, {
        apiKey: replacementKey, apiKeySessionOnly: true,
      });
      expect(updated.success).toBe(true);
      expect(readSettings().providerAccounts[0]).not.toHaveProperty('apiKey');
      expect(getSessionApiKey(saved.data.id)).toBe(replacementKey);
      expect(JSON.stringify(updated)).not.toContain(replacementKey);
    });

    it('encrypts a replacement key and clears the previous session-only flag', async () => {
      const saved = await call(IPC_CHANNELS.PROVIDER_ACCOUNTS_SAVE, { ...account, apiKeySessionOnly: true });
      const replacementKey = 'updated-provider-key';
      const updated = await call(IPC_CHANNELS.PROVIDER_ACCOUNTS_UPDATE, saved.data.id, { apiKey: replacementKey });

      expect(updated.success).toBe(true);
      expect(isSecretEnvelope(readSettings().providerAccounts[0].apiKey)).toBe(true);
      expect(readFileSync(settingsPath(), 'utf-8')).not.toContain(replacementKey);
      expect(readSettings().providerAccounts[0]).not.toHaveProperty('apiKeySessionOnly');
      expect(getSessionApiKey(saved.data.id)).toBeUndefined();
      expect(storedKey(readSettings().providerAccounts[0])).toBe(replacementKey);
    });
  });

  it('preserves unrelated keys', async () => {
    writeFileSync(settingsPath(), JSON.stringify({ theme: 'dark', apiKeys: { openai: 'sk-x' } }));

    const saved = await call(IPC_CHANNELS.PROVIDER_ACCOUNTS_SAVE, newAccount('a@x.com'));
    expect(saved.success).toBe(true);
    let s = readSettings();
    expect(s.theme).toBe('dark');
    expect(s.apiKeys).toEqual({ openai: 'sk-x' });
    expect(s.providerAccounts).toHaveLength(1);

    await call(IPC_CHANNELS.PROVIDER_ACCOUNTS_SET_QUEUE_ORDER, ['z']);
    s = readSettings();
    expect(s.theme).toBe('dark');
    expect(s.globalPriorityOrder).toEqual(['z']);
    expect(manager.setAccountPriorityOrder).toHaveBeenCalledWith(['z']);

    const del = await call(IPC_CHANNELS.PROVIDER_ACCOUNTS_DELETE, saved.data.id);
    expect(del.success).toBe(true);
    s = readSettings();
    expect(s.theme).toBe('dark');
    expect(s.apiKeys).toEqual({ openai: 'sk-x' });
    expect(s.providerAccounts).toEqual([]);
  });

  it('persists ~10 concurrent SAVE calls with all ids queued', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => call(IPC_CHANNELS.PROVIDER_ACCOUNTS_SAVE, newAccount(`u${i}@x.com`)))
    );
    expect(results.every((r) => r.success)).toBe(true);
    const ids = results.map((r) => r.data.id as string);
    const s = readSettings();
    expect(s.providerAccounts).toHaveLength(10);
    expect(s.providerAccounts.map((a: { id: string }) => a.id).sort()).toEqual([...ids].sort());
    expect([...s.globalPriorityOrder].sort()).toEqual([...ids].sort());
  });

  it('concurrent SAVE and UPDATE do not lose each other', async () => {
    const first = await call(IPC_CHANNELS.PROVIDER_ACCOUNTS_SAVE, newAccount('a@x.com', 'old'));
    const [upd, created] = await Promise.all([
      call(IPC_CHANNELS.PROVIDER_ACCOUNTS_UPDATE, first.data.id, { name: 'renamed' }),
      call(IPC_CHANNELS.PROVIDER_ACCOUNTS_SAVE, newAccount('b@x.com', 'second')),
    ]);
    expect(upd.success).toBe(true);
    expect(created.success).toBe(true);
    const s = readSettings();
    const byId = Object.fromEntries(s.providerAccounts.map((a: { id: string }) => [a.id, a]));
    expect(byId[first.data.id].name).toBe('renamed');
    expect(byId[created.data.id].name).toBe('second');
    expect(s.globalPriorityOrder).toEqual(expect.arrayContaining([first.data.id, created.data.id]));
  });

  it('returns DUPLICATE_EMAIL and not-found errors without modifying the file', async () => {
    const first = await call(IPC_CHANNELS.PROVIDER_ACCOUNTS_SAVE, newAccount('a@x.com', 'First'));
    const before = readFileSync(settingsPath(), 'utf-8');

    const dup = await call(IPC_CHANNELS.PROVIDER_ACCOUNTS_SAVE, newAccount('A@X.com', 'Other'));
    expect(dup).toEqual({ success: false, error: 'DUPLICATE_EMAIL:First' });

    const upd = await call(IPC_CHANNELS.PROVIDER_ACCOUNTS_UPDATE, 'missing', { name: 'n' });
    expect(upd).toEqual({ success: false, error: 'Account not found: missing' });

    const del = await call(IPC_CHANNELS.PROVIDER_ACCOUNTS_DELETE, 'missing');
    expect(del).toEqual({ success: false, error: 'Account not found: missing' });

    expect(readFileSync(settingsPath(), 'utf-8')).toBe(before);
    expect(first.success).toBe(true);
  });
});

describe('settings handlers and secure storage', () => {
  it('returns SECURE_STORAGE_UNAVAILABLE when a new memory key cannot be encrypted', async () => {
    state.encryptionAvailable = false;
    const before = '{"theme":"dark"}';
    writeFileSync(settingsPath(), before);

    expect(await call(IPC_CHANNELS.SETTINGS_SAVE, { memoryVoyageApiKey: 'test-memory-key' })).toEqual({
      success: false, error: 'SECURE_STORAGE_UNAVAILABLE',
    });
    expect(readFileSync(settingsPath(), 'utf-8')).toBe(before);
  });

  it('persists other SETTINGS_GET migrations while deferring provider migration', async () => {
    state.encryptionAvailable = false;
    const legacyApiKey = 'test-legacy-profile-key';
    state.loadProfilesFile.mockResolvedValue({
      profiles: [{ name: 'Legacy profile', baseUrl: 'https://example.com', apiKey: legacyApiKey }],
    });
    const existingAccount = { ...newAccount('test@example.com'), id: 'existing', createdAt: 1, updatedAt: 1 };
    writeFileSync(settingsPath(), JSON.stringify({
      providerAccounts: [existingAccount], globalPriorityOrder: [existingAccount.id],
    }));

    expect((await call(IPC_CHANNELS.SETTINGS_GET)).success).toBe(true);
    const settings = readSettings();
    expect(settings._migratedAgentProfileToAuto).toBe(true);
    expect(settings._migratedDefaultModelSync).toBe(true);
    expect(settings).not.toHaveProperty('_migratedProviderAccounts');
    expect(settings.providerAccounts).toEqual([existingAccount]);
    expect(settings.globalPriorityOrder).toEqual([existingAccount.id]);
    expect(readFileSync(settingsPath(), 'utf-8')).not.toContain(legacyApiKey);

    state.encryptionAvailable = true;
    expect((await call(IPC_CHANNELS.SETTINGS_GET)).success).toBe(true);
    const migrated = readSettings();
    expect(migrated._migratedProviderAccounts).toBe(true);
    expect(migrated.providerAccounts).toHaveLength(2);
    expect(isSecretEnvelope(migrated.providerAccounts[1].apiKey)).toBe(true);
  });
});
