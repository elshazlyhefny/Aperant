import { beforeEach, describe, expect, it, vi } from 'vitest';

// zeenha fork: the build never checks for, downloads or installs an upstream
// release. These assert no updater network call happens on any entry point.
const autoUpdater = vi.hoisted(() => ({
  autoDownload: true,
  autoInstallOnAppQuit: true,
  allowPrerelease: false,
  channel: 'latest',
  logger: null as unknown,
  currentVersion: { version: '2.8.0-beta.6.zeenha.1' },
  on: vi.fn(),
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn(),
}));

vi.mock('electron-updater', () => ({ autoUpdater }));
vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '2.8.0-beta.6.zeenha.1', getPath: () => '/tmp', on: vi.fn() },
  BrowserWindow: class {},
}));

describe('app updater (zeenha fork: disabled)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not install on quit', async () => {
    await import('../app-updater');
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
  });

  it('initializing registers no update handlers and schedules no check', async () => {
    vi.useFakeTimers();
    const updater = await import('../app-updater');
    updater.initializeAppUpdater({ webContents: { send: vi.fn() } } as never, true);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(autoUpdater.on).not.toHaveBeenCalled();
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('manual check, download, downgrade check and install all do nothing', async () => {
    const updater = await import('../app-updater');
    expect(await updater.checkForUpdates()).toBeNull();
    await updater.downloadUpdate();
    expect(await updater.checkForStableDowngrade()).toBeNull();
    await updater.downloadStableVersion();
    expect(updater.quitAndInstall()).toBe(false);
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });
});
