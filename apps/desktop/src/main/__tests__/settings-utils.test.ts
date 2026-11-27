import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { state, safeStorage, fakeEncrypt } = vi.hoisted(() => {
  const transform = (bytes: Buffer) => Buffer.from(bytes.map((byte) => byte ^ 0xff));
  const fakeEncrypt = (plaintext: string) => transform(Buffer.from(plaintext));
  return {
    fakeEncrypt,
    state: { userData: '' },
    safeStorage: {
      isEncryptionAvailable: vi.fn(() => true),
      getSelectedStorageBackend: () => 'gnome_libsecret',
      encryptString: vi.fn(fakeEncrypt),
      decryptString: vi.fn((ciphertext: Buffer) => transform(ciphertext).toString()),
    },
  };
});

vi.mock('electron', () => ({
  app: { getPath: () => state.userData },
  safeStorage,
}));

import type { ProviderAccount } from '../../shared/types/provider-account';
import { isSecretEnvelope, wrapEnvelope } from '../../shared/utils/secret-envelope';
import { isWindows } from '../platform';
import { clearSecretCacheForTests, SecureStorageUnavailableError } from '../secure-storage/secret-storage';
import { clearSessionApiKeys } from '../secure-storage/session-credentials';
import {
  migrateSettingsSecrets,
  readSettingsFile,
  readSettingsFileAsync,
  secureSettingsFilePermissions,
  SettingsUnreadableError,
  updateSettingsFile,
  writeSettingsFile,
} from '../settings-utils';

const mode = (p: string) => statSync(p).mode & 0o777;

const providerAccount = {
  id: 'test-account',
  name: 'Test account',
  provider: 'openai',
  authType: 'api-key',
  billingModel: 'pay-per-use',
  apiKey: 'sk-test-SECRET',
  createdAt: 1,
  updatedAt: 1,
} satisfies ProviderAccount;

describe('settings-utils', () => {
  let root: string;
  let settingsPath: string;

  beforeEach(() => {
    vi.resetAllMocks();
    clearSecretCacheForTests();
    clearSessionApiKeys();
    root = mkdtempSync(join(tmpdir(), 'settings-utils-'));
    state.userData = join(root, 'userData');
    settingsPath = join(state.userData, 'settings.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

      const result = updateSettingsFile(mutator);
      await expect(result).rejects.toBeInstanceOf(SettingsUnreadableError);
      await expect(result).rejects.not.toHaveProperty('cause');
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

  describe('settings secrets', () => {
    const diskBytes = () => readFileSync(settingsPath, 'utf-8');

    it('encrypts new keys on disk and decodes them for readers and mutators', async () => {
      await updateSettingsFile((settings) => { settings.providerAccounts = [providerAccount]; });

      expect(diskBytes()).not.toContain(providerAccount.apiKey);
      expect(isSecretEnvelope(JSON.parse(diskBytes()).providerAccounts[0].apiKey)).toBe(true);
      expect(readSettingsFile()?.providerAccounts).toEqual([providerAccount]);
      expect((await readSettingsFileAsync())?.providerAccounts).toEqual([providerAccount]);
      await updateSettingsFile((settings) => {
        expect(settings.providerAccounts).toEqual([providerAccount]);
      });
    });

    it('migrates legacy provider, global and memory keys', async () => {
      const legacy = {
        providerAccounts: [providerAccount],
        globalAnthropicApiKey: 'old-anthropic-key',
        globalOpenAIApiKey: 'old-openai-key',
        memoryVoyageApiKey: 'old-voyage-key',
      };
      writeSettingsFile(legacy);

      await expect(migrateSettingsSecrets()).resolves.toBe('migrated');
      const { providerAccounts, ...legacyKeys } = legacy;
      for (const key of [providerAccounts[0].apiKey, ...Object.values(legacyKeys)]) {
        expect(diskBytes()).not.toContain(key);
      }
      expect(readSettingsFile()).toEqual(legacy);
      await expect(migrateSettingsSecrets()).resolves.toBe('unchanged');
    });

    it('does not rewrite already-encrypted settings during a no-op', async () => {
      await updateSettingsFile((settings) => { settings.providerAccounts = [providerAccount]; });
      const before = diskBytes();
      const oldMtime = new Date('2020-01-01T00:00:00Z');
      utimesSync(settingsPath, oldMtime, oldMtime);
      safeStorage.encryptString.mockClear();

      await updateSettingsFile(() => undefined);
      expect(statSync(settingsPath).mtimeMs).toBe(oldMtime.getTime());
      expect(diskBytes()).toBe(before);
      expect(safeStorage.encryptString).not.toHaveBeenCalled();
    });

    it('leaves the file unchanged and releases the lock after a failed migration', async () => {
      writeSettingsFile({ providerAccounts: [providerAccount], globalOpenAIApiKey: 'other-test-key' });
      const before = diskBytes();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      safeStorage.encryptString.mockImplementation((key) => {
        if (key === providerAccount.apiKey) throw new Error('Keychain failure');
        return fakeEncrypt(key);
      });

      await expect(updateSettingsFile(() => undefined)).rejects.toBeInstanceOf(SecureStorageUnavailableError);
      await expect(migrateSettingsSecrets()).resolves.toBe('failed');
      expect(warn).toHaveBeenCalledExactlyOnceWith('[Settings] Could not migrate stored credentials; settings.json was left unchanged');
      expect(diskBytes()).toBe(before);
      expect(readdirSync(state.userData)).toEqual(['settings.json']);
      safeStorage.encryptString.mockReset();
      await expect(migrateSettingsSecrets()).resolves.toBe('migrated');
    });

    it('preserves existing plaintext with no secure backend but refuses new keys', async () => {
      const legacy = { providerAccounts: [providerAccount], globalOpenAIApiKey: 'old-openai-key' };
      writeSettingsFile(legacy);
      const original = diskBytes();
      safeStorage.isEncryptionAvailable.mockReturnValue(false);

      await expect(migrateSettingsSecrets()).resolves.toBe('skipped-no-backend');
      expect(diskBytes()).toBe(original);
      await updateSettingsFile((settings) => { settings.theme = 'dark'; });
      expect(JSON.parse(diskBytes())).toEqual({ ...legacy, theme: 'dark' });

      const before = diskBytes();
      await expect(updateSettingsFile((settings) => {
        settings.providerAccounts?.push({ ...providerAccount, id: 'new-account', apiKey: 'new-test-key' });
      })).rejects.toBeInstanceOf(SecureStorageUnavailableError);
      expect(diskBytes()).toBe(before);
      expect(readdirSync(state.userData)).toEqual(['settings.json']);
    });

    it('preserves an undecryptable envelope during an unrelated update', async () => {
      const envelope = wrapEnvelope('dGVzdA==');
      writeSettingsFile({ providerAccounts: [{ ...providerAccount, apiKey: envelope }] });
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      safeStorage.decryptString.mockImplementation(() => { throw new Error('Keyring changed'); });

      await updateSettingsFile((settings) => { settings.theme = 'dark'; });
      expect(JSON.parse(diskBytes()).providerAccounts[0].apiKey).toBe(envelope);
      expect(readSettingsFile()?.providerAccounts?.[0].apiKey).toBe(envelope);
      expect(safeStorage.encryptString).not.toHaveBeenCalled();
    });

    it('holds session-only keys in memory even with no secure backend', async () => {
      const account = { ...providerAccount, apiKeySessionOnly: true };
      safeStorage.isEncryptionAvailable.mockReturnValue(false);
      await updateSettingsFile((settings) => { settings.providerAccounts = [account]; });

      const storedAccount = JSON.parse(diskBytes()).providerAccounts[0];
      expect(storedAccount).not.toHaveProperty('apiKey');
      expect(storedAccount.apiKeySessionOnly).toBe(true);
      expect(readSettingsFile()?.providerAccounts).toEqual([account]);
      expect(safeStorage.encryptString).not.toHaveBeenCalled();
      clearSessionApiKeys();
      expect(readSettingsFile()?.providerAccounts?.[0]).not.toHaveProperty('apiKey');
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
