import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  SettingsUnreadableError,
  updateSettingsFile,
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

  describe('updateSettingsFile', () => {
    const leftovers = () =>
      readdirSync(state.userData).filter((f) => f.endsWith('.tmp') || f.endsWith('.lock'));

    it('rejects a corrupt file and leaves it untouched', async () => {
      mkdirSync(state.userData, { recursive: true });
      writeFileSync(settingsPath, '{ not json');
      const mutator = vi.fn();

      await expect(updateSettingsFile(mutator)).rejects.toBeInstanceOf(SettingsUnreadableError);
      expect(mutator).not.toHaveBeenCalled();
      expect(readFileSync(settingsPath, 'utf-8')).toBe('{ not json');
      expect(leftovers()).toEqual([]);
    });

    it.each(['[1,2]', 'null', '42'])('rejects non-object content %s', async (content) => {
      mkdirSync(state.userData, { recursive: true });
      writeFileSync(settingsPath, content);
      const mutator = vi.fn();

      await expect(updateSettingsFile(mutator)).rejects.toMatchObject({ code: 'SETTINGS_UNREADABLE' });
      expect(mutator).not.toHaveBeenCalled();
      expect(readFileSync(settingsPath, 'utf-8')).toBe(content);
      expect(leftovers()).toEqual([]);
    });

    it('starts from {} for a missing file and creates it with 0o600', async () => {
      let received: unknown;
      await updateSettingsFile((s) => {
        received = { ...s };
        (s as Record<string, unknown>).a = 1;
      });
      expect(received).toEqual({});
      expect(readSettingsFile()).toEqual({ a: 1 });
      if (!isWindows()) expect(mode(settingsPath)).toBe(0o600);
      expect(leftovers()).toEqual([]);
    });

    it('persists distinct keys from concurrent updates', async () => {
      for (const n of [2, 20]) {
        rmSync(state.userData, { recursive: true, force: true });
        await Promise.all(
          Array.from({ length: n }, (_, i) =>
            updateSettingsFile((s) => {
              (s as Record<string, unknown>)[`k${i}`] = i;
            })
          )
        );
        const result = readSettingsFile() as Record<string, unknown>;
        expect(Object.keys(result).sort()).toEqual(
          Array.from({ length: n }, (_, i) => `k${i}`).sort()
        );
      }
      expect(leftovers()).toEqual([]);
    });

    it('does not lose increments under concurrency', async () => {
      const N = 20;
      await Promise.all(
        Array.from({ length: N }, () =>
          updateSettingsFile((s) => {
            const r = s as Record<string, number>;
            r.counter = (r.counter ?? 0) + 1;
          })
        )
      );
      expect((readSettingsFile() as Record<string, number>).counter).toBe(N);
    });

    it('leaves the file unchanged when the mutator throws and releases the lock', async () => {
      writeSettingsFile({ a: 1 });
      const before = readFileSync(settingsPath, 'utf-8');

      await expect(
        updateSettingsFile((s) => {
          (s as Record<string, unknown>).a = 2;
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');
      expect(readFileSync(settingsPath, 'utf-8')).toBe(before);

      await updateSettingsFile((s) => {
        (s as Record<string, unknown>).b = 3;
      });
      expect(readSettingsFile()).toEqual({ a: 1, b: 3 });
      expect(leftovers()).toEqual([]);
    });

    it('honors async mutators and returns their value', async () => {
      const value = await updateSettingsFile(async (s) => {
        await new Promise((r) => setTimeout(r, 10));
        (s as Record<string, unknown>).x = 'y';
        return 'done';
      });
      expect(value).toBe('done');
      expect(readSettingsFile()).toEqual({ x: 'y' });
    });

    it('does not rewrite the file when the mutator changes nothing', async () => {
      mkdirSync(state.userData, { recursive: true });
      const raw = '{"a":1}';
      writeFileSync(settingsPath, raw);

      const value = await updateSettingsFile(() => 7);
      expect(value).toBe(7);
      expect(readFileSync(settingsPath, 'utf-8')).toBe(raw);
      expect(leftovers()).toEqual([]);
    });

    it('preserves keys written by other tools', async () => {
      mkdirSync(state.userData, { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({ foreign: { deep: [1] }, a: 1 }));
      await updateSettingsFile((s) => {
        (s as Record<string, unknown>).b = 2;
      });
      expect(readSettingsFile()).toEqual({ foreign: { deep: [1] }, a: 1, b: 2 });
    });
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
