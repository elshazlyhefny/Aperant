import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { AppSettings, IPCResult, ProviderAccount, RendererAppSettings } from '../../shared/types';
import { toProviderAccountView } from '../../shared/utils/provider-account-view';
import { registerSettingsHandlers } from '../ipc-handlers/settings-handlers';

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }));
const store = vi.hoisted(() => ({ data: {} as Partial<AppSettings> }));
vi.mock('../settings-utils', async (orig) => ({
  ...(await orig<typeof import('../settings-utils')>()),
  readSettingsFile: () => structuredClone(store.data),
  updateSettingsFile: async (fn: (settings: Partial<AppSettings>) => unknown) => {
    const settings = structuredClone(store.data);
    const result = await fn(settings);
    store.data = settings;
    return result;
  },
}));
vi.mock('../app-updater', () => ({ setUpdateChannel: vi.fn(), setUpdateChannelWithDowngradeCheck: vi.fn() }));
vi.mock('../cli-tool-manager', () => ({
  configureTools: vi.fn(), getToolPath: vi.fn(), getToolInfo: vi.fn(),
  isPathFromWrongPlatform: vi.fn(), preWarmToolCache: vi.fn(async () => undefined),
}));

const SENTINEL = 'saved-provider-credential-sentinel-179';
const accounts: ProviderAccount[] = [
  {
    id: 'pa_api_key',
    provider: 'openai',
    name: 'API key account',
    authType: 'api-key',
    billingModel: 'pay-per-use',
    apiKey: SENTINEL,
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'pa_oauth',
    provider: 'anthropic',
    name: 'OAuth account',
    authType: 'oauth',
    billingModel: 'subscription',
    apiKey: SENTINEL,
    createdAt: 1,
    updatedAt: 1,
  },
];

const mockIpcMain = ipcMain as unknown as {
  invokeHandler: (channel: string, event: unknown, ...args: unknown[]) => Promise<unknown>;
};

describe('Settings IPC provider credentials', () => {
  beforeAll(() => {
    registerSettingsHandlers({ configure: vi.fn() } as never, () => null);
  });

  beforeEach(() => {
    store.data = {
      _migratedProviderAccounts: true,
      _migratedAgentProfileToAuto: true,
      _migratedDefaultModelSync: true,
      _migratedUltrathinkToHigh: true,
      _migratedToPerProviderConfig: true,
      autoBuildPath: 'prompts',
      providerAccounts: structuredClone(accounts),
    };
  });

  it.each([
    { scenario: 'without a migration', migrate: false },
    { scenario: 'when persisting a migration', migrate: true },
  ])('SETTINGS_GET omits saved keys $scenario', async ({ migrate }) => {
    if (migrate) delete store.data._migratedAgentProfileToAuto;

    const result = await mockIpcMain.invokeHandler(IPC_CHANNELS.SETTINGS_GET, {}) as IPCResult<RendererAppSettings>;

    expect(result.success).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(result.data?.providerAccounts).toMatchObject([
      { id: 'pa_api_key', authType: 'api-key', hasApiKey: true },
      { id: 'pa_oauth', authType: 'oauth', hasApiKey: true },
    ]);
    expect(result.data?.providerAccounts?.every(account => !Object.hasOwn(account, 'apiKey'))).toBe(true);
    expect(store.data._migratedAgentProfileToAuto).toBe(true);
    expect(store.data.providerAccounts).toEqual(accounts);
  });

  it('SETTINGS_SAVE ignores renderer account views and preserves saved keys', async () => {
    const result = await mockIpcMain.invokeHandler(IPC_CHANNELS.SETTINGS_SAVE, {}, {
      theme: 'light',
      providerAccounts: [toProviderAccountView(accounts[0])],
    });

    expect(result).toEqual({ success: true });
    expect(store.data.theme).toBe('light');
    expect(store.data.providerAccounts).toEqual(accounts);
  });
});
