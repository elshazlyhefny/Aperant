import { describe, it, expect, vi, beforeEach } from 'vitest';

const toolkit = vi.hoisted(() => ({ is: { dev: true } }));
vi.mock('@electron-toolkit/utils', () => toolkit);

import { ipcMain } from 'electron';
import { isTrustedSender } from '../ipc-sender-validation';
import { registerTerminalHandlers } from '../ipc-handlers/terminal-handlers';
import { IPC_CHANNELS } from '../../shared/constants';

vi.mock('../claude-profile-manager', () => ({ getClaudeProfileManager: vi.fn() }));
vi.mock('../claude-profile/usage-monitor', () => ({ getUsageMonitor: vi.fn() }));
vi.mock('../project-store', () => ({ projectStore: {} }));
vi.mock('../terminal-name-generator', () => ({ terminalNameGenerator: {} }));
vi.mock('../settings-utils', () => ({ readSettingsFileAsync: vi.fn() }));
vi.mock('../claude-profile/session-utils', () => ({ migrateSession: vi.fn() }));
vi.mock('../claude-profile/profile-utils', () => ({ createProfileDirectory: vi.fn() }));
vi.mock('../utils/config-path-validator', () => ({ isValidConfigDir: vi.fn() }));
vi.mock('../terminal-manager', () => ({ TerminalManager: class {} }));

const DEV_URL = 'http://localhost:5173';

describe('isTrustedSender', () => {
  beforeEach(() => {
    toolkit.is.dev = true;
    process.env['ELECTRON_RENDERER_URL'] = DEV_URL;
  });

  it('trusts the app dev URL', () => {
    expect(isTrustedSender({ senderFrame: { url: `${DEV_URL}/#/home` } })).toBe(true);
  });

  it('trusts the prod file URL', () => {
    toolkit.is.dev = false;
    const url = new URL('../../renderer/index.html', `file://${__dirname.replace('__tests__', '')}/`).toString();
    expect(isTrustedSender({ senderFrame: { url } })).toBe(true);
  });

  it('rejects an https attacker URL', () => {
    expect(isTrustedSender({ senderFrame: { url: 'https://evil.example.com/' } })).toBe(false);
  });

  it('rejects a null or missing senderFrame', () => {
    expect(isTrustedSender({ senderFrame: null })).toBe(false);
    expect(isTrustedSender({})).toBe(false);
  });
});

describe('TERMINAL_CREATE sender validation', () => {
  it('rejects untrusted events and accepts trusted ones', async () => {
    toolkit.is.dev = true;
    process.env['ELECTRON_RENDERER_URL'] = DEV_URL;
    const create = vi.fn().mockResolvedValue({ success: true });
    registerTerminalHandlers({ create } as never, () => null);
    vi.spyOn(console, 'warn').mockReturnValue(undefined);

    const bad = await (ipcMain as never as { invokeHandler: Function }).invokeHandler(
      IPC_CHANNELS.TERMINAL_CREATE,
      { senderFrame: { url: 'https://evil.example.com/' } },
      {}
    );
    expect(bad).toEqual({ success: false, error: 'Untrusted sender' });
    expect(create).not.toHaveBeenCalled();

    const good = await (ipcMain as never as { invokeHandler: Function }).invokeHandler(
      IPC_CHANNELS.TERMINAL_CREATE,
      { senderFrame: { url: DEV_URL } },
      {}
    );
    expect(good).toEqual({ success: true });
    expect(create).toHaveBeenCalledTimes(1);
  });
});
