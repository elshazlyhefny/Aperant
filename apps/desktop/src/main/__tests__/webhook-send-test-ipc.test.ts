import { describe, it, expect, vi, beforeEach } from 'vitest';

const toolkit = vi.hoisted(() => ({ is: { dev: true } }));
vi.mock('@electron-toolkit/utils', () => toolkit);

const webhook = vi.hoisted(() => ({
  sendTestWebhook: vi.fn(async (..._args: unknown[]) => ({ success: true })),
  saved: undefined as Record<string, unknown> | undefined,
}));
vi.mock('../settings-utils', async (orig) => ({
  ...(await orig<typeof import('../settings-utils')>()),
  readSettingsFile: () => webhook.saved,
}));
vi.mock('../task-webhook', async (orig) => ({
  ...(await orig<typeof import('../task-webhook')>()),
  sendTestWebhook: webhook.sendTestWebhook,
}));

vi.mock('../app-updater', () => ({ setUpdateChannel: vi.fn(), setUpdateChannelWithDowngradeCheck: vi.fn() }));
vi.mock('../cli-tool-manager', () => ({
  configureTools: vi.fn(), getToolPath: vi.fn(), getToolInfo: vi.fn(),
  isPathFromWrongPlatform: vi.fn(), preWarmToolCache: vi.fn(),
}));

import { ipcMain } from 'electron';
import { registerSettingsHandlers } from '../ipc-handlers/settings-handlers';
import { IPC_CHANNELS } from '../../shared/constants';

const DEV_URL = 'http://localhost:5173';
const SECRET_URL = 'https://hooks.example.com/services/SECRET-TOKEN';

type Res = { success: boolean; error?: string; data?: unknown };
let registered = false;
function getHandler() {
  if (!registered) {
    registerSettingsHandlers({ configure: vi.fn() } as never, (() => null) as never);
    registered = true;
  }
  const mock = ipcMain as never as { invokeHandler: (c: string, ...a: unknown[]) => Promise<Res> };
  return (event: unknown, url: unknown, ...rest: unknown[]) =>
    mock.invokeHandler(IPC_CHANNELS.WEBHOOK_SEND_TEST, event, url, ...rest);
}

describe('WEBHOOK_SEND_TEST handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    webhook.saved = undefined;
    toolkit.is.dev = true;
    process.env['ELECTRON_RENDERER_URL'] = DEV_URL;
  });

  it('rejects untrusted senders without sending', async () => {
    const res = await getHandler()({ senderFrame: { url: 'https://evil.example.com' } }, SECRET_URL);
    expect(res).toEqual({ success: false, error: 'untrusted_sender' });
    expect(webhook.sendTestWebhook).not.toHaveBeenCalled();
  });

  it('rejects invalid URLs', async () => {
    const res = await getHandler()({ senderFrame: { url: DEV_URL } }, 'not a url');
    expect(res).toEqual({ success: false, error: 'invalid_url' });
    expect(webhook.sendTestWebhook).not.toHaveBeenCalled();
  });

  it('never returns the URL in the response', async () => {
    const ok = await getHandler()({ senderFrame: { url: DEV_URL } }, SECRET_URL);
    expect(ok.success).toBe(true);
    expect(JSON.stringify(ok)).not.toContain('SECRET-TOKEN');
    webhook.sendTestWebhook.mockResolvedValueOnce({ success: false, error: 'delivery_failed' } as never);
    const bad = await getHandler()({ senderFrame: { url: DEV_URL } }, SECRET_URL);
    expect(bad).toEqual({ success: false, error: 'delivery_failed' });
  });

  it('signs with the secret argument', async () => {
    await getHandler()({ senderFrame: { url: DEV_URL } }, SECRET_URL, ' arg-secret ');
    expect(webhook.sendTestWebhook).toHaveBeenCalledWith(SECRET_URL, { secret: 'arg-secret' });
  });

  it('falls back to the saved secret when the argument is undefined', async () => {
    webhook.saved = { webhook: { secret: 'saved-secret' } };
    await getHandler()({ senderFrame: { url: DEV_URL } }, SECRET_URL);
    expect(webhook.sendTestWebhook).toHaveBeenCalledWith(SECRET_URL, { secret: 'saved-secret' });
  });

  it('an empty argument overrides the saved secret', async () => {
    webhook.saved = { webhook: { secret: 'saved-secret' } };
    await getHandler()({ senderFrame: { url: DEV_URL } }, SECRET_URL, '');
    expect(webhook.sendTestWebhook).toHaveBeenCalledWith(SECRET_URL, { secret: '' });
  });

  it.each([['too long', 'a'.repeat(257)], ['newline', 'a\nb'], ['non-string', 5]])(
    'rejects an invalid secret (%s)',
    async (_n, bad) => {
      const res = await getHandler()({ senderFrame: { url: DEV_URL } }, SECRET_URL, bad);
      expect(res).toEqual({ success: false, error: 'invalid_webhook_secret' });
      expect(webhook.sendTestWebhook).not.toHaveBeenCalled();
    }
  );
});
