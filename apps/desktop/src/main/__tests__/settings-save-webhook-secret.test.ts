import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }));
const store = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock('../settings-utils', async (orig) => ({
  ...(await orig<typeof import('../settings-utils')>()),
  readSettingsFile: () => store.data,
  updateSettingsFile: async (fn: (s: Record<string, unknown>) => unknown) => fn(store.data),
}));
vi.mock('../app-updater', () => ({ setUpdateChannel: vi.fn(), setUpdateChannelWithDowngradeCheck: vi.fn() }));
vi.mock('../cli-tool-manager', () => ({
  configureTools: vi.fn(), getToolPath: vi.fn(), getToolInfo: vi.fn(),
  isPathFromWrongPlatform: vi.fn(), preWarmToolCache: vi.fn(async () => undefined),
}));

import { ipcMain } from 'electron';
import { registerSettingsHandlers } from '../ipc-handlers/settings-handlers';
import { IPC_CHANNELS } from '../../shared/constants';

type Res = { success: boolean; error?: string };
const events = { reviewReady: true, failed: true, blocked: true, prOpened: false };
let registered = false;
async function save(webhook: Record<string, unknown>): Promise<Res> {
  if (!registered) {
    registerSettingsHandlers({ configure: vi.fn() } as never, (() => null) as never);
    registered = true;
  }
  const mock = ipcMain as never as { invokeHandler: (c: string, ...a: unknown[]) => Promise<Res> };
  return mock.invokeHandler(IPC_CHANNELS.SETTINGS_SAVE, {}, { webhook });
}
const saved = () => (store.data.webhook as { secret?: string }).secret;

describe('SETTINGS_SAVE webhook secret', () => {
  beforeEach(() => { store.data = {}; });

  it('persists a trimmed secret', async () => {
    expect((await save({ enabled: false, url: '', events, secret: '  abc  ' })).success).toBe(true);
    expect(saved()).toBe('abc');
  });

  it('keeps the stored secret when omitted', async () => {
    await save({ enabled: false, url: '', events, secret: 'abc' });
    await save({ enabled: false, url: '', events });
    expect(saved()).toBe('abc');
  });

  it('allows clearing with an empty string', async () => {
    await save({ enabled: false, url: '', events, secret: 'abc' });
    await save({ enabled: false, url: '', events, secret: '' });
    expect(saved()).toBe('');
  });

  it.each([['too long', 'a'.repeat(257)], ['newline', 'a\nb'], ['control char', 'a\u0007b'], ['non-string', 7]])(
    'rejects %s and keeps the stored value',
    async (_n, bad) => {
      await save({ enabled: false, url: '', events, secret: 'abc' });
      const res = await save({ enabled: false, url: '', events, secret: bad });
      expect(res).toEqual({ success: false, error: 'invalid_webhook_secret' });
      expect(saved()).toBe('abc');
    }
  );
});
