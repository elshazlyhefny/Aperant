/**
 * Tests for api-profile-store.ts
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProfilesFile } from '@shared/types/profile';
import { isSecretEnvelope, wrapEnvelope } from '../../../shared/utils/secret-envelope';
import { isWindows } from '../../platform';
import { clearSecretCacheForTests, SecureStorageUnavailableError } from '../../secure-storage/secret-storage';
import {
  atomicModifyProfiles,
  generateProfileId,
  getProfilesFilePath,
  loadProfilesFile,
  migrateProfilesSecrets,
  saveProfilesFile,
  validateFilePermissions
} from './api-profile-store';
import { createProfile, updateProfile } from './profile-service';

const { state, safeStorage, fakeEncrypt } = vi.hoisted(() => {
  const transform = (bytes: Buffer) => Buffer.from(bytes.map((byte) => byte ^ 0xff));
  const fakeEncrypt = (plaintext: string, nonce = 0) =>
    Buffer.concat([Buffer.of(nonce), transform(Buffer.from(plaintext))]);
  return {
    state: { userData: '' },
    fakeEncrypt,
    safeStorage: {
      isEncryptionAvailable: vi.fn(() => true),
      getSelectedStorageBackend: () => 'gnome_libsecret',
      encryptString: vi.fn((plaintext: string) => fakeEncrypt(plaintext)),
      decryptString: vi.fn((encrypted: Buffer) => transform(encrypted.subarray(1)).toString())
    }
  };
});

vi.mock('electron', () => ({
  app: { getPath: () => state.userData },
  safeStorage
}));

function fixture(): ProfilesFile {
  return {
    profiles: [{
      id: 'fixture-id-1',
      name: 'Fixture Profile',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-fixture-key',
      models: { default: 'claude-sonnet' },
      createdAt: 1700000000000,
      updatedAt: 1700000001000
    }],
    activeProfileId: 'fixture-id-1',
    version: 1
  };
}

const readRaw = () => fs.readFile(getProfilesFilePath(), 'utf-8');

async function writeRaw(content: string): Promise<void> {
  await fs.mkdir(path.dirname(getProfilesFilePath()), { recursive: true });
  await fs.writeFile(getProfilesFilePath(), content);
}

async function expectNoLeftovers(): Promise<void> {
  expect(await fs.readdir(path.dirname(getProfilesFilePath()))).toEqual(['profiles.json']);
}

describe('api-profile-store', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    clearSecretCacheForTests();
    state.userData = await fs.mkdtemp(path.join(tmpdir(), 'api-profile-store-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(state.userData, { recursive: true, force: true });
  });

  describe('loadProfilesFile', () => {
    const empty = { profiles: [], activeProfileId: null, version: 1 };

    it('returns default profiles when the file is missing', async () => {
      expect(await loadProfilesFile()).toEqual(empty);
    });

    it.each(['invalid json{', '{"version":1}'])('returns default profiles for invalid data: %s', async (raw) => {
      await writeRaw(raw);
      expect(await loadProfilesFile()).toEqual(empty);
    });

    it('loads a legacy v1 profiles.json from the auto-claude directory', async () => {
      const file = fixture();
      expect(getProfilesFilePath()).toBe(path.join(state.userData, 'auto-claude', 'profiles.json'));
      await writeRaw(JSON.stringify(file));
      expect(await loadProfilesFile()).toEqual(file);
    });
  });

  describe('saveProfilesFile', () => {
    it('encrypts profile keys and retains an owner-only file mode', async () => {
      const file = fixture();
      await saveProfilesFile(file);

      const raw = await readRaw();
      expect(raw).not.toContain(file.profiles[0].apiKey);
      expect(isSecretEnvelope(JSON.parse(raw).profiles[0].apiKey)).toBe(true);
      expect(await loadProfilesFile()).toEqual(file);
      if (!isWindows()) expect((await fs.stat(getProfilesFilePath())).mode & 0o777).toBe(0o600);
    });

    it('propagates write failures and keeps the previous file', async () => {
      const raw = JSON.stringify(fixture());
      await writeRaw(raw);
      vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('Write failed'));

      await expect(saveProfilesFile(fixture())).rejects.toThrow('Write failed');
      expect(await readRaw()).toBe(raw);
      await expectNoLeftovers();
    });
  });

  describe('atomicModifyProfiles', () => {
    it('writes only an envelope, with a temp file opened in owner-only mode', async () => {
      const file = fixture();
      const writeFile = vi.spyOn(fs, 'writeFile');
      expect(await atomicModifyProfiles(() => file)).toEqual(file);

      const raw = await readRaw();
      expect(raw).not.toContain(file.profiles[0].apiKey);
      expect(isSecretEnvelope(JSON.parse(raw).profiles[0].apiKey)).toBe(true);
      expect(writeFile).toHaveBeenCalledWith(`${getProfilesFilePath()}.tmp`, raw, { encoding: 'utf-8', mode: 0o600 });
      expect(await loadProfilesFile()).toEqual(file);
      await expectNoLeftovers();
    });

    it('gives the modifier plaintext but keeps each unchanged envelope byte-for-byte', async () => {
      const file = fixture();
      file.profiles.push({ ...file.profiles[0], id: 'fixture-id-2' });
      const raw = JSON.stringify({
        ...file,
        profiles: file.profiles.map((profile, i) => ({
          ...profile,
          apiKey: wrapEnvelope(fakeEncrypt(profile.apiKey, i).toString('base64'))
        }))
      }, null, 2);
      await writeRaw(raw);

      await atomicModifyProfiles((decoded) => {
        expect(decoded).toEqual(file);
        return decoded;
      });
      await saveProfilesFile(file);
      expect(await readRaw()).toBe(raw);
      expect(safeStorage.encryptString).not.toHaveBeenCalled();
    });

    it('passes an undecryptable envelope through an unrelated update', async () => {
      const file = fixture();
      const envelope = wrapEnvelope(fakeEncrypt(file.profiles[0].apiKey).toString('base64'));
      file.profiles[0].apiKey = envelope;
      await writeRaw(JSON.stringify(file));
      safeStorage.decryptString.mockImplementation(() => { throw new Error('Keyring changed'); });
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      await atomicModifyProfiles((decoded) => ({ ...decoded, activeProfileId: null }));
      expect(JSON.parse(await readRaw()).profiles[0].apiKey).toBe(envelope);
      expect(safeStorage.encryptString).not.toHaveBeenCalled();
    });

    it('preserves a legacy key in its original slot but refuses to copy it to a new profile without a backend', async () => {
      const file = fixture();
      await writeRaw(JSON.stringify(file));
      safeStorage.isEncryptionAvailable.mockReturnValue(false);
      await atomicModifyProfiles((decoded) => ({ ...decoded, activeProfileId: null }));
      const before = await readRaw();
      expect(JSON.parse(before).profiles[0].apiKey).toBe(file.profiles[0].apiKey);

      await expect(atomicModifyProfiles((decoded) => {
        decoded.profiles.push({ ...decoded.profiles[0], id: 'new-id' });
        return decoded;
      })).rejects.toBeInstanceOf(SecureStorageUnavailableError);
      await expect(saveProfilesFile({
        ...file,
        profiles: [{ ...file.profiles[0], apiKey: 'replacement-key' }]
      })).rejects.toMatchObject({ code: 'SECURE_STORAGE_UNAVAILABLE' });
      expect(await readRaw()).toBe(before);
      await expectNoLeftovers();
    });

    it('surfaces storage refusals to profile service callers without saving the new key', async () => {
      const file = fixture();
      const before = JSON.stringify(file);
      await writeRaw(before);
      safeStorage.isEncryptionAvailable.mockReturnValue(false);
      const newKey = { ...file.profiles[0], apiKey: 'replacement-key' };

      await expect(createProfile({ ...newKey, name: 'New profile' })).rejects.toMatchObject({ code: 'SECURE_STORAGE_UNAVAILABLE' });
      await expect(updateProfile(newKey)).rejects.toMatchObject({ code: 'SECURE_STORAGE_UNAVAILABLE' });
      expect(await readRaw()).toBe(before);
      await expectNoLeftovers();
    });

    it('leaves the original bytes and no temp file if encoding fails', async () => {
      const file = fixture();
      const before = JSON.stringify(file);
      await writeRaw(before);
      safeStorage.encryptString.mockImplementation(() => { throw new Error('Encryption failed'); });

      await expect(atomicModifyProfiles((decoded) => decoded)).rejects.toBeInstanceOf(SecureStorageUnavailableError);
      expect(await readRaw()).toBe(before);
      await expectNoLeftovers();
    });
  });

  describe('migrateProfilesSecrets', () => {
    it('encrypts legacy plaintext and leaves encrypted files unchanged on repeat runs', async () => {
      const file = fixture();
      await writeRaw(JSON.stringify(file));
      await migrateProfilesSecrets();

      const raw = await readRaw();
      expect(raw).not.toContain(file.profiles[0].apiKey);
      expect(isSecretEnvelope(JSON.parse(raw).profiles[0].apiKey)).toBe(true);
      expect(await loadProfilesFile()).toEqual(file);
      const writeFile = vi.spyOn(fs, 'writeFile');
      await migrateProfilesSecrets();
      expect(writeFile).not.toHaveBeenCalled();
      expect(await readRaw()).toBe(raw);
    });

    it('does not create a missing file or rewrite a corrupt file', async () => {
      await migrateProfilesSecrets();
      expect(await fs.readdir(state.userData)).toEqual([]);

      await writeRaw('{invalid');
      await migrateProfilesSecrets();
      expect(await readRaw()).toBe('{invalid');
      await expectNoLeftovers();
    });

    it('skips migration when storage is unavailable', async () => {
      const before = JSON.stringify(fixture());
      await writeRaw(before);
      safeStorage.isEncryptionAvailable.mockReturnValue(false);
      await migrateProfilesSecrets();
      expect(await readRaw()).toBe(before);
      expect(safeStorage.encryptString).not.toHaveBeenCalled();
    });

    it('does not rewrite the file or log secrets when encryption fails', async () => {
      const file = fixture();
      const before = JSON.stringify(file);
      await writeRaw(before);
      safeStorage.encryptString.mockImplementation((plaintext) => { throw new Error(plaintext); });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(migrateProfilesSecrets()).resolves.toBeUndefined();
      expect(warn.mock.calls).toEqual([['[ProfileStore] Failed to migrate API profile secrets']]);
      expect(await readRaw()).toBe(before);
      await expectNoLeftovers();
    });
  });

  describe('generateProfileId', () => {
    it('should generate unique UUID v4 format IDs', () => {
      const id1 = generateProfileId();
      const id2 = generateProfileId();

      // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
      expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(id2).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

      // IDs should be unique
      expect(id1).not.toBe(id2);
    });

    it('should generate different IDs on consecutive calls', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateProfileId());
      }
      expect(ids.size).toBe(100);
    });
  });

  describe('validateFilePermissions', () => {
    it('sets user-only read/write permissions', async () => {
      await writeRaw(JSON.stringify(fixture()));
      expect(await validateFilePermissions(getProfilesFilePath())).toBe(true);
      if (!isWindows()) expect((await fs.stat(getProfilesFilePath())).mode & 0o777).toBe(0o600);
    });

    it('returns false if chmod fails', async () => {
      expect(await validateFilePermissions(getProfilesFilePath())).toBe(false);
    });
  });
});
