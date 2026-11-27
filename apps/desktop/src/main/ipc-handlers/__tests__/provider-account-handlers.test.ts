import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const state = vi.hoisted(() => ({
  userData: '',
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => state.userData },
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

import { registerProviderAccountHandlers } from '../provider-account-handlers';
import { IPC_CHANNELS } from '../../../shared/constants';

type Res = { success: boolean; error?: string; data?: any };

function call(channel: string, ...args: unknown[]): Promise<Res> {
  const fn = state.handlers.get(channel);
  if (!fn) throw new Error(`No handler for ${channel}`);
  return fn({}, ...args) as Promise<Res>;
}

const settingsPath = () => path.join(state.userData, 'settings.json');
const readSettings = () => JSON.parse(readFileSync(settingsPath(), 'utf-8'));
const newAccount = (email: string, name = email) =>
  ({ provider: 'openai', name, email, authType: 'api-key', billingModel: 'pay-per-use' }) as const;

describe('provider account handlers', () => {
  beforeAll(() => {
    registerProviderAccountHandlers();
  });

  beforeEach(() => {
    if (state.userData) rmSync(state.userData, { recursive: true, force: true });
    state.userData = mkdtempSync(path.join(tmpdir(), 'provider-accounts-'));
    manager.setAccountPriorityOrder.mockClear();
  });

  afterAll(() => {
    rmSync(state.userData, { recursive: true, force: true });
  });

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
      expect(stored).toMatchObject({ id: res.data.id, apiKey: SENTINEL });
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
      expect(stored).toMatchObject({ name: 'Renamed', apiKey: SENTINEL, keyStatus: 'valid', keyStatusAt: 200 });
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
      expect(stored.apiKey).toBe(replacement);
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
      expect(stored).toMatchObject({ baseUrl, apiKey: SENTINEL });
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
