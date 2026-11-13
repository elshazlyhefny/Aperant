import { describe, it, expect, vi, beforeEach } from 'vitest';

const toolkit = vi.hoisted(() => ({ is: { dev: true } }));
vi.mock('@electron-toolkit/utils', () => toolkit);

import { readFileSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { ipcMain } from 'electron';
import { getAppRendererUrl } from '../navigation-guard';
import { EventEmitter } from 'events';
import { isTrustedSender, installIpcSenderGuard, UNGUARDED_IPC_CHANNELS } from '../ipc-sender-validation';
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
    const url = getAppRendererUrl(dirname(fileURLToPath(new URL('../ipc-sender-validation.ts', import.meta.url))), false);
    expect(isTrustedSender({ senderFrame: { url } })).toBe(true);
  });

  it('defines its own ESM __dirname instead of relying on a global (undefined in the built bundle)', () => {
    const source = readFileSync(fileURLToPath(new URL('../ipc-sender-validation.ts', import.meta.url)), 'utf8');
    expect(source).toMatch(/const __dirname\s*=\s*dirname\(\s*__filename\s*\)/);
    expect(source).toMatch(/const __filename\s*=\s*fileURLToPath\(\s*import\.meta\.url\s*\)/);
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

describe('installIpcSenderGuard', () => {
  const good = () => ({ senderFrame: { url: DEV_URL } });
  const evil = { senderFrame: { url: 'https://evil.example' } };

  function makeIpc() {
    const handlers = new Map<string, (...a: any[]) => any>();
    const emitter = new EventEmitter();
    const ipc = {
      handle: (c: string, h: any) => void handlers.set(c, h),
      handleOnce: (c: string, h: any) => void handlers.set(c, h),
      on: (c: string, l: any) => (emitter.on(c, l), ipc),
      once: (c: string, l: any) => (emitter.once(c, l), ipc),
    };
    return { ipc, handlers, emitter };
  }

  beforeEach(() => {
    toolkit.is.dev = true;
    process.env['ELECTRON_RENDERER_URL'] = DEV_URL;
    vi.spyOn(console, 'warn').mockReturnValue(undefined);
  });

  for (const method of ['handle', 'handleOnce'] as const) {
    describe(method, () => {
      it('rejects untrusted and missing senders without calling the handler', async () => {
        const { ipc, handlers } = makeIpc();
        installIpcSenderGuard(ipc);
        const fn = vi.fn();
        ipc[method]('chan', fn);
        expect(() => handlers.get('chan')!(evil)).toThrow('Untrusted sender');
        expect(() => handlers.get('chan')!({ senderFrame: null })).toThrow('Untrusted sender');
        expect(() => handlers.get('chan')!(undefined)).toThrow('Untrusted sender');
        expect(fn).not.toHaveBeenCalled();
      });

      it('passes trusted events through with args and result', async () => {
        const { ipc, handlers } = makeIpc();
        installIpcSenderGuard(ipc);
        const fn = vi.fn().mockResolvedValue('ok');
        ipc[method]('chan', fn);
        const ev = good();
        await expect(handlers.get('chan')!(ev, 1, 'a')).resolves.toBe('ok');
        expect(fn).toHaveBeenCalledWith(ev, 1, 'a');
      });
    });
  }

  for (const method of ['on', 'once'] as const) {
    it(`${method} ignores untrusted senders and calls trusted listeners`, () => {
      const { ipc, emitter } = makeIpc();
      installIpcSenderGuard(ipc);
      const fn = vi.fn();
      expect(ipc[method]('chan', fn)).toBe(ipc);
      emitter.emit('chan', evil);
      expect(fn).not.toHaveBeenCalled();
      emitter.emit('chan', good(), 5);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn.mock.calls[0][1]).toBe(5);
    });
  }

  it('registers allowlisted channels unwrapped', () => {
    expect(UNGUARDED_IPC_CHANNELS.has(IPC_CHANNELS.GITHUB_AUTH_CHANGED)).toBe(true);
    const { ipc, emitter } = makeIpc();
    installIpcSenderGuard(ipc);
    const fn = vi.fn();
    ipc.on(IPC_CHANNELS.GITHUB_AUTH_CHANGED, fn);
    emitter.emit(IPC_CHANNELS.GITHUB_AUTH_CHANGED, 'not-an-event');
    expect(fn).toHaveBeenCalledWith('not-an-event');
  });

  it('does not double-wrap on a second install', () => {
    const { ipc, handlers } = makeIpc();
    installIpcSenderGuard(ipc);
    installIpcSenderGuard(ipc);
    const fn = vi.fn();
    ipc.handle('chan', fn);
    handlers.get('chan')!(good());
    expect(fn).toHaveBeenCalledTimes(1);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('removeListener by original reference removes a wrapped on listener', () => {
    const { ipc, emitter } = makeIpc();
    installIpcSenderGuard(ipc);
    const fn = vi.fn();
    ipc.on('chan', fn);
    emitter.removeListener('chan', fn);
    emitter.emit('chan', good());
    expect(fn).not.toHaveBeenCalled();
  });
});
