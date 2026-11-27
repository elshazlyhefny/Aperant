/**
 * zeenha fork: protect persisted provider keys with Electron safeStorage.
 * Unlike OAuth token encryption, this module never falls back to plaintext.
 */
import { safeStorage } from 'electron';
import { unwrapEnvelope, wrapEnvelope } from '../../shared/utils/secret-envelope';
import { isLinux } from '../platform';

type UnavailableReason = 'no-safe-storage' | 'encryption-unavailable' | 'insecure-linux-backend';
type SecureStorageBackend =
  | { available: true; storage: typeof safeStorage }
  | { available: false; reason: UnavailableReason; cause?: unknown };

const MAX_CACHED_SECRETS = 64;
const decryptedSecrets = new Map<string, string>();

export class SecureStorageUnavailableError extends Error {
  readonly code = 'SECURE_STORAGE_UNAVAILABLE';

  constructor(cause?: unknown) {
    super('Secure storage is unavailable', { cause });
    this.name = 'SecureStorageUnavailableError';
  }
}

function checkBackend(): SecureStorageBackend {
  let storage: typeof safeStorage;
  try {
    // Vitest mocks that omit the named export can throw on access.
    storage = safeStorage;
  } catch (cause) {
    return { available: false, reason: 'no-safe-storage', cause };
  }
  if (!storage) return { available: false, reason: 'no-safe-storage' };

  try {
    if (!storage.isEncryptionAvailable()) {
      return { available: false, reason: 'encryption-unavailable' };
    }
    if (isLinux()) {
      const backend = storage.getSelectedStorageBackend();
      if (!backend || backend === 'basic_text' || backend === 'unknown') {
        return { available: false, reason: 'insecure-linux-backend' };
      }
    }
    return { available: true, storage };
  } catch (cause) {
    return { available: false, reason: 'encryption-unavailable', cause };
  }
}

export function getSecureStorageStatus(): { available: boolean; reason?: UnavailableReason } {
  const backend = checkBackend();
  return backend.available ? { available: true } : { available: false, reason: backend.reason };
}

export function isSecureStorageAvailable(): boolean {
  return getSecureStorageStatus().available;
}

export function encryptSecret(plaintext: string): string {
  const backend = checkBackend();
  if (!backend.available) throw new SecureStorageUnavailableError(backend.cause);

  try {
    return wrapEnvelope(backend.storage.encryptString(plaintext).toString('base64'));
  } catch (cause) {
    throw new SecureStorageUnavailableError(cause);
  }
}

export function decryptSecret(envelope: string): string | null {
  try {
    const payload = unwrapEnvelope(envelope);
    if (payload === null) {
      console.warn('[SecretStorage] Invalid secret envelope');
      return null;
    }

    const backend = checkBackend();
    if (!backend.available) {
      console.warn('[SecretStorage] Cannot decrypt: secure storage is unavailable');
      return null;
    }

    const cached = decryptedSecrets.get(envelope);
    if (cached !== undefined) return cached;

    const plaintext = backend.storage.decryptString(Buffer.from(payload, 'base64'));
    if (decryptedSecrets.size >= MAX_CACHED_SECRETS) {
      const oldest = decryptedSecrets.keys().next().value;
      if (oldest !== undefined) decryptedSecrets.delete(oldest);
    }
    decryptedSecrets.set(envelope, plaintext);
    return plaintext;
  } catch {
    // Do not include the envelope or backend error in logs.
    console.warn('[SecretStorage] Failed to decrypt secret');
    return null;
  }
}

/** Clear cached plaintext between tests. */
export function clearSecretCacheForTests(): void {
  decryptedSecrets.clear();
}
