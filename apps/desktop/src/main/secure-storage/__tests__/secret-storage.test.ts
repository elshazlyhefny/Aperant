import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SECRET_ENVELOPE_PREFIX, isSecretEnvelope, unwrapEnvelope, wrapEnvelope } from '../../../shared/utils/secret-envelope';
import {
  SecureStorageUnavailableError,
  clearSecretCacheForTests,
  decryptSecret,
  encryptSecret,
  getSecureStorageStatus,
  isSecureStorageAvailable
} from '../secret-storage';

const { mockStorage, isLinux } = vi.hoisted(() => {
  // A reversible fake for testing the wrapper, not a real cipher.
  const transform = (bytes: Buffer) => Buffer.from(bytes.map(byte => byte ^ 0xff));
  const storage = {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
    encryptString: vi.fn((value: string) => transform(Buffer.from(value, 'utf8'))),
    decryptString: vi.fn((value: Buffer) => transform(value).toString('utf8'))
  };
  return { mockStorage: { storage, current: storage as typeof storage | undefined }, isLinux: vi.fn(() => true) };
});

vi.mock('electron', () => ({
  get safeStorage() {
    return mockStorage.current;
  }
}));
vi.mock('../../platform', () => ({ isLinux }));

const SECRET = 'provider-key-for-testing';
const { storage } = mockStorage;

describe('secret storage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockStorage.current = storage;
    clearSecretCacheForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('round trips without including plaintext in the envelope and caches successful decryptions', () => {
    const envelope = encryptSecret(SECRET);
    expect(isSecretEnvelope(envelope)).toBe(true);
    expect(envelope).not.toContain(SECRET);
    expect(decryptSecret(envelope)).toBe(SECRET);
    expect(decryptSecret(envelope)).toBe(SECRET);
    expect(storage.decryptString).toHaveBeenCalledTimes(1);

    clearSecretCacheForTests();
    expect(decryptSecret(envelope)).toBe(SECRET);
    expect(storage.decryptString).toHaveBeenCalledTimes(2);
  });

  it('refuses to encrypt if safeStorage is undefined', () => {
    mockStorage.current = undefined;
    expect(getSecureStorageStatus()).toEqual({ available: false, reason: 'no-safe-storage' });
    expect(encryptSecret.bind(null, SECRET)).toThrow(SecureStorageUnavailableError);
  });

  it('refuses to encrypt if safeStorage reports encryption unavailable', () => {
    storage.isEncryptionAvailable.mockReturnValue(false);
    expect(getSecureStorageStatus()).toEqual({ available: false, reason: 'encryption-unavailable' });
    expect(encryptSecret.bind(null, SECRET)).toThrow(SecureStorageUnavailableError);
    expect(storage.encryptString).not.toHaveBeenCalled();
  });

  it('refuses to encrypt if checking availability throws', () => {
    storage.isEncryptionAvailable.mockImplementation(() => { throw new Error('Backend failure'); });
    expect(getSecureStorageStatus()).toEqual({ available: false, reason: 'encryption-unavailable' });
    expect(encryptSecret.bind(null, SECRET)).toThrow(SecureStorageUnavailableError);
  });

  it.each(['basic_text', 'unknown'])('refuses the Linux %s backend', (backend) => {
    storage.getSelectedStorageBackend.mockReturnValue(backend);
    expect(getSecureStorageStatus()).toEqual({ available: false, reason: 'insecure-linux-backend' });
    expect(isSecureStorageAvailable()).toBe(false);
    expect(encryptSecret.bind(null, SECRET)).toThrow(SecureStorageUnavailableError);
    expect(storage.encryptString).not.toHaveBeenCalled();
  });

  it('does not query the Linux backend on other platforms', () => {
    isLinux.mockReturnValue(false);
    storage.getSelectedStorageBackend.mockReturnValue('basic_text');
    expect(getSecureStorageStatus()).toEqual({ available: true });
    expect(decryptSecret(encryptSecret(SECRET))).toBe(SECRET);
    expect(storage.getSelectedStorageBackend).not.toHaveBeenCalled();
  });

  it('throws a typed error with the underlying cause if encryption fails', () => {
    const cause = new Error('Keychain failure');
    storage.encryptString.mockImplementation(() => { throw cause; });
    const encrypt = () => encryptSecret(SECRET);
    expect(encrypt).toThrow(SecureStorageUnavailableError);
    expect(encrypt).toThrow(expect.objectContaining({ code: 'SECURE_STORAGE_UNAVAILABLE', cause }));
  });

  it('returns null on a decrypt error and does not log the error or envelope', () => {
    const envelope = encryptSecret(SECRET);
    storage.decryptString.mockImplementation(() => { throw new Error(SECRET); });
    expect(decryptSecret(envelope)).toBeNull();
    expect(console.warn).toHaveBeenCalledExactlyOnceWith('[SecretStorage] Failed to decrypt secret');
  });

  it.each([SECRET, SECRET_ENVELOPE_PREFIX, wrapEnvelope('bad!'), wrapEnvelope('a==a')])(
    'rejects malformed input before invoking safeStorage',
    (input) => {
      expect(unwrapEnvelope(input)).toBeNull();
      expect(decryptSecret(input)).toBeNull();
      expect(storage.decryptString).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledExactlyOnceWith('[SecretStorage] Invalid secret envelope');
    }
  );

  it('refuses to decrypt even cached envelopes if the backend becomes unavailable', () => {
    const envelope = encryptSecret(SECRET);
    expect(decryptSecret(envelope)).toBe(SECRET);
    storage.isEncryptionAvailable.mockReturnValue(false);
    expect(decryptSecret(envelope)).toBeNull();
    expect(storage.decryptString).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledExactlyOnceWith('[SecretStorage] Cannot decrypt: secure storage is unavailable');
  });

  it('handles Electron mocks that omit the safeStorage export entirely', async () => {
    vi.doMock('electron', () => ({}));
    vi.resetModules();
    try {
      const isolated = await import('../secret-storage');
      expect(isolated.getSecureStorageStatus()).toEqual({ available: false, reason: 'no-safe-storage' });
      expect(() => isolated.encryptSecret(SECRET)).toThrow(isolated.SecureStorageUnavailableError);
    } finally {
      vi.doUnmock('electron');
    }
  });
});
