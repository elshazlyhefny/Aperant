/**
 * zeenha fork: proves the global IPC sender guard covers EVERY registered channel.
 *
 * Part A (dynamic): runs the real registration code (setupIpcHandlers + Sentry) against a
 * recording fake ipcMain, then calls each registered function with an untrusted sender.
 * Part B (static): bans the ipcMain APIs that bypass the guard and pins the install order.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync, statSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { IPC_CHANNELS } from '../../shared/constants/ipc';

const TEST_DIR = mkdtempSync(path.join(tmpdir(), 'ipc-guard-coverage-'));

type Kind = 'handle' | 'handleOnce' | 'on' | 'once';
interface Registration {
  kind: Kind;
  channel: string;
  fn: (...args: unknown[]) => unknown;
}

const recorded: Registration[] = [];

vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    on: vi.fn(),
    checkForUpdates: vi.fn(() => Promise.resolve(null)),
    downloadUpdate: vi.fn(() => Promise.resolve()),
    quitAndInstall: vi.fn(),
  },
}));

vi.mock('@electron-toolkit/utils', () => ({
  is: {
    dev: true,
    windows: process.platform === 'win32',
    macos: process.platform === 'darwin',
    linux: process.platform === 'linux',
  },
  electronApp: { setAppUserModelId: vi.fn() },
  optimizer: { watchWindowShortcuts: vi.fn() },
}));

vi.mock('../updater/version-manager', () => ({
  getEffectiveVersion: vi.fn(() => '0.1.0'),
  getBundledVersion: vi.fn(() => '0.1.0'),
  parseVersionFromTag: vi.fn((tag: string) => tag.replace('v', '')),
  compareVersions: vi.fn(() => 0),
}));

vi.mock('../notification-service', () => ({
  notificationService: {
    initialize: vi.fn(),
    notifyReviewNeeded: vi.fn(),
    notifyTaskFailed: vi.fn(),
  },
}));

vi.mock('electron-log/main.js', () => ({
  default: {
    initialize: vi.fn(),
    transports: {
      file: {
        maxSize: 10 * 1024 * 1024,
        format: '',
        fileName: 'main.log',
        level: 'info',
        getFile: vi.fn(() => ({ path: '/tmp/test.log' })),
      },
      console: { level: 'warn', format: '' },
    },
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../cli-tool-manager', () => ({
  getToolInfo: vi.fn(() => ({ found: false, path: null, source: 'mock' })),
  getToolPath: vi.fn((tool: string) => tool),
  deriveGitBashPath: vi.fn(() => null),
  clearCache: vi.fn(),
  clearToolCache: vi.fn(),
  configureTools: vi.fn(),
  preWarmToolCache: vi.fn(() => Promise.resolve()),
  getToolPathAsync: vi.fn((tool: string) => Promise.resolve(tool)),
}));

vi.mock('@sentry/electron/main', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
  setContext: vi.fn(),
  setTag: vi.fn(),
  setUser: vi.fn(),
}));

vi.mock('electron', () => {
  const record = (kind: Kind) =>
    function (this: unknown, channel: string, fn: (...args: unknown[]) => unknown) {
      recorded.push({ kind, channel, fn });
      return this;
    };
  const mockIpcMain = new (class {
    handle = record('handle');
    handleOnce = record('handleOnce');
    on = record('on');
    once = record('once');
    removeHandler(): void {}
    emit(): boolean {
      return false;
    }
  })();

  return {
    app: {
      getPath: vi.fn((name: string) =>
        name === 'userData' ? path.join(TEST_DIR, 'userData') : TEST_DIR
      ),
      getAppPath: vi.fn(() => TEST_DIR),
      getVersion: vi.fn(() => '0.1.0'),
      isPackaged: false,
    },
    ipcMain: mockIpcMain,
    dialog: {
      showOpenDialog: vi.fn(() => Promise.resolve({ canceled: true, filePaths: [] })),
    },
    BrowserWindow: class {
      webContents = { send: vi.fn() };
    },
  };
});

process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173';

const UNTRUSTED_EVENT = { senderFrame: { url: 'https://evil.example' } };
const NULL_FRAME_EVENT = { senderFrame: null };

describe('IPC sender guard covers every registered channel (dynamic)', () => {
  let unguarded: ReadonlyMap<string, string>;

  beforeAll(async () => {
    mkdirSync(path.join(TEST_DIR, 'userData', 'store'), { recursive: true });
    const mockWindow = {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn(), isDestroyed: vi.fn(() => false) },
    };
    const agentManager = Object.assign(new EventEmitter(), {
      startSpecCreation: vi.fn(),
      startTaskExecution: vi.fn(),
      startQAProcess: vi.fn(),
      killTask: vi.fn(),
      configure: vi.fn(),
    });
    const terminalManager = {
      create: vi.fn(() => Promise.resolve({ success: true })),
      destroy: vi.fn(() => Promise.resolve({ success: true })),
      write: vi.fn(),
      resize: vi.fn(),
      killAll: vi.fn(() => Promise.resolve()),
    };

    const { setupIpcHandlers } = await import('../ipc-handlers');
    setupIpcHandlers(agentManager as never, terminalManager as never, () => mockWindow as never);

    // Same order as main/index.ts: the guard is already installed, Sentry registers after.
    const { initSentryMain } = await import('../sentry');
    initSentryMain();

    ({ UNGUARDED_IPC_CHANNELS: unguarded } = await import('../ipc-sender-validation'));
  }, 120000);

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('captures a large number of registrations', () => {
    expect(recorded.length).toBeGreaterThan(300);
  });

  it('captures the Sentry channels registered outside setupIpcHandlers', () => {
    const channels = new Set(recorded.map((r) => r.channel));
    expect(channels.has(IPC_CHANNELS.SENTRY_STATE_CHANGED)).toBe(true);
    expect(channels.has(IPC_CHANNELS.GET_SENTRY_DSN)).toBe(true);
    expect(channels.has(IPC_CHANNELS.GET_SENTRY_CONFIG)).toBe(true);
  });

  it('rejects an untrusted sender on every guarded channel', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failures: string[] = [];
    let checked = 0;

    for (const { kind, channel, fn } of recorded) {
      if (unguarded.has(channel)) continue;
      checked++;
      warn.mockClear();

      if (kind === 'handle' || kind === 'handleOnce') {
        let message: string | undefined;
        try {
          await fn(UNTRUSTED_EVENT);
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
        if (message !== 'Untrusted sender') failures.push(`${kind} ${channel}: got ${message}`);
      } else {
        try {
          fn(UNTRUSTED_EVENT);
        } catch (err) {
          failures.push(`${kind} ${channel}: threw ${String(err)}`);
          continue;
        }
        const rejected = warn.mock.calls.some(
          (c) => typeof c[0] === 'string' && c[0].includes(`[ipc] Rejected ${channel}`)
        );
        if (!rejected) failures.push(`${kind} ${channel}: no rejection warning`);
      }
    }

    warn.mockRestore();
    expect(checked).toBeGreaterThan(300);
    expect(failures).toEqual([]);
  });

  it('rejects a null senderFrame on a sample of channels', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sample = recorded
      .filter((r) => !unguarded.has(r.channel) && (r.kind === 'handle' || r.kind === 'handleOnce'))
      .filter((_, i) => i % 25 === 0);
    expect(sample.length).toBeGreaterThan(5);
    for (const { channel, fn } of sample) {
      await expect(Promise.resolve().then(() => fn(NULL_FRAME_EVENT)), channel).rejects.toThrow(
        'Untrusted sender'
      );
    }
    warn.mockRestore();
  });

  it('leaves the reviewed unguarded channels as raw listeners', () => {
    expect(unguarded.size).toBeGreaterThan(0);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const channel of unguarded.keys()) {
      const regs = recorded.filter((r) => r.channel === channel);
      expect(regs.length, `${channel} should be registered`).toBeGreaterThan(0);
      for (const { fn } of regs) {
        try {
          fn();
        } catch {
          // The raw body may fail on missing args; only the guard's warning matters here.
        }
      }
    }
    const guardWarned = warn.mock.calls.some(
      (c) => typeof c[0] === 'string' && c[0].includes('[ipc] Rejected')
    );
    warn.mockRestore();
    expect(guardWarned).toBe(false);
  });
});

describe('IPC sender guard cannot be bypassed (static)', () => {
  const SRC = path.resolve(__dirname, '..');

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === '__tests__' || name === 'node_modules') continue;
        out.push(...sourceFiles(full));
      } else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) {
        out.push(full);
      }
    }
    return out;
  }

  it('no main-process source uses ipcMain APIs that bypass the guard', () => {
    const banned = /ipcMain\s*\.\s*(addListener|prependListener|prependOnceListener)\s*\(/;
    const offenders = sourceFiles(SRC).filter((f) => banned.test(readFileSync(f, 'utf-8')));
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it('main/index.ts installs the guard before initSentryMain()', () => {
    const src = readFileSync(path.join(SRC, 'index.ts'), 'utf-8');
    const guard = src.indexOf('installIpcSenderGuard(ipcMain)');
    const sentry = src.indexOf('initSentryMain()');
    expect(guard).toBeGreaterThan(-1);
    expect(sentry).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(sentry);
  });

  it('ipc-handlers/index.ts installs the guard before its first ipcMain.handle(', () => {
    const src = readFileSync(path.join(SRC, 'ipc-handlers', 'index.ts'), 'utf-8');
    const guard = src.indexOf('installIpcSenderGuard(ipcMain)');
    const handle = src.indexOf('ipcMain.handle(');
    expect(guard).toBeGreaterThan(-1);
    expect(handle).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(handle);
  });
});
