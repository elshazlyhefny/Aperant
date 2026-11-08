import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: true } }));

import { DEV_USER_DATA_DIR, isolateDevInstance } from '../dev-instance-isolation';

describe('isolateDevInstance', () => {
  let appPath: string;

  const devApp = (isPackaged = false) => ({
    isPackaged,
    getAppPath: () => appPath,
    setPath: vi.fn(),
  });

  beforeEach(() => {
    appPath = mkdtempSync(join(tmpdir(), 'dev-isolation-'));
  });

  afterEach(() => {
    rmSync(appPath, { recursive: true, force: true });
  });

  it('leaves a packaged app on its normal data folder', () => {
    const target = devApp(true);

    expect(isolateDevInstance(target as never)).toBeNull();
    expect(target.setPath).not.toHaveBeenCalled();
  });

  it('moves a dev instance to a data folder inside its own checkout', () => {
    const target = devApp();
    isolateDevInstance(target as never);

    expect(target.setPath).toHaveBeenCalledWith('userData', join(appPath, DEV_USER_DATA_DIR));
  });

  it('skips onboarding for a new data folder without overwriting an existing one', () => {
    isolateDevInstance(devApp() as never);
    const settingsPath = join(appPath, DEV_USER_DATA_DIR, 'settings.json');
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8'))).toEqual({ onboardingCompleted: true });

    writeFileSync(settingsPath, '{"theme":"dark"}');
    isolateDevInstance(devApp() as never);
    expect(readFileSync(settingsPath, 'utf-8')).toBe('{"theme":"dark"}');
  });

  it('runs before the startup modules that read userData while loading', () => {
    const source = readFileSync(resolve(__dirname, '../index.ts'), 'utf-8');
    const isolation = source.indexOf("import './dev-instance-isolation'");

    expect(isolation).toBeGreaterThan(-1);
    for (const later of ["from './ipc-setup'", "from './agent'", "from './terminal-manager'"]) {
      expect(source.indexOf(later)).toBeGreaterThan(isolation);
    }
  });
});
