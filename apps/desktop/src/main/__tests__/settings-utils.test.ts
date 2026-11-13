import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => state.userData },
}));

import { isWindows } from '../platform';
import {
  readSettingsFile,
  secureSettingsFilePermissions,
  writeSettingsFile,
} from '../settings-utils';

const mode = (p: string) => statSync(p).mode & 0o777;

describe('settings-utils', () => {
  let root: string;
  let settingsPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'settings-utils-'));
    state.userData = join(root, 'userData');
    settingsPath = join(state.userData, 'settings.json');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes settings.json with owner-only permissions', () => {
    writeSettingsFile({ a: 1 });
    if (!isWindows()) expect(mode(settingsPath)).toBe(0o600);
  });

  it('round-trips content through readSettingsFile', () => {
    writeSettingsFile({ theme: 'dark', nested: { x: [1, 2] } });
    expect(readSettingsFile()).toEqual({ theme: 'dark', nested: { x: [1, 2] } });
  });

  it('tightens a pre-existing 0o644 file on overwrite', () => {
    writeSettingsFile({ a: 1 });
    chmodSync(settingsPath, 0o644);
    writeSettingsFile({ a: 2 });
    if (!isWindows()) expect(mode(settingsPath)).toBe(0o600);
    expect(readSettingsFile()).toEqual({ a: 2 });
  });

  it('leaves no temp files after a successful write', () => {
    writeSettingsFile({ a: 1 });
    expect(readdirSync(state.userData).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('creates a missing userData directory', () => {
    expect(existsSync(state.userData)).toBe(false);
    writeSettingsFile({ a: 1 });
    expect(existsSync(settingsPath)).toBe(true);
  });

  it('keeps the previous file and no temp file when a write fails', () => {
    writeSettingsFile({ a: 1 });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => writeSettingsFile(circular)).toThrow();
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8'))).toEqual({ a: 1 });
    expect(readdirSync(state.userData).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('secureSettingsFilePermissions tightens an existing file and tolerates absence', () => {
    expect(() => secureSettingsFilePermissions()).not.toThrow();

    writeSettingsFile({ a: 1 });
    writeFileSync(settingsPath, '{}');
    chmodSync(settingsPath, 0o644);
    secureSettingsFilePermissions();
    if (!isWindows()) expect(mode(settingsPath)).toBe(0o600);
  });
});
