/**
 * API Profile Store - File I/O for API profiles
 *
 * The only reader/writer of userData/auto-claude/profiles.json for API
 * (custom endpoint) profiles.
 * Claude OAuth accounts are handled by claude-profile-manager.ts, and
 * validation/CRUD for API profiles lives in profile-service.ts (built on this store).
 *
 * Provides graceful handling for missing or corrupted files.
 * Uses file locking and atomic modify to prevent race conditions in concurrent operations.
 * zeenha fork: encrypt API keys at the disk boundary without a plaintext fallback for new keys.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { app } from 'electron';
// @ts-expect-error - no types available for proper-lockfile
import * as lockfile from 'proper-lockfile';
import type { APIProfile, ProfilesFile } from '@shared/types/profile';
import { isSecretEnvelope } from '../../../shared/utils/secret-envelope';
import {
  decryptSecret,
  encryptSecret,
  isSecureStorageAvailable,
  SecureStorageUnavailableError
} from '../../secure-storage/secret-storage';

/**
 * Get the path to profiles.json in the auto-claude directory
 */
export function getProfilesFilePath(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'auto-claude', 'profiles.json');
}

/**
 * Check if a value is a valid profile object with required fields
 */
function isValidProfile(value: unknown): value is APIProfile {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const profile = value as Record<string, unknown>;
  return (
    typeof profile.id === 'string' &&
    typeof profile.name === 'string' &&
    typeof profile.baseUrl === 'string' &&
    typeof profile.apiKey === 'string' &&
    typeof profile.createdAt === 'number' &&
    typeof profile.updatedAt === 'number'
  );
}

/**
 * Validate the structure of parsed profiles data
 */
function isValidProfilesFile(data: unknown): data is ProfilesFile {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const obj = data as Record<string, unknown>;

  // Check profiles is an array
  if (!Array.isArray(obj.profiles)) {
    return false;
  }

  // Check each profile has required fields
  for (const profile of obj.profiles) {
    if (!isValidProfile(profile)) {
      return false;
    }
  }

  // Check activeProfileId is string or null
  if (obj.activeProfileId !== null && typeof obj.activeProfileId !== 'string') {
    return false;
  }

  // Check version is a number
  if (typeof obj.version !== 'number') {
    return false;
  }

  return true;
}

/**
 * Default profiles file structure for fallback
 */
function getDefaultProfilesFile(): ProfilesFile {
  return {
    profiles: [],
    activeProfileId: null,
    version: 1
  };
}

type OriginalKey = { plaintext: string; onDisk: string };

function transformProfileKeys(
  file: ProfilesFile,
  transform: (apiKey: string, slot: string) => string
): ProfilesFile {
  const occurrences = new Map<string, number>();
  return {
    ...file,
    profiles: file.profiles.map((profile) => {
      const occurrence = occurrences.get(profile.id) ?? 0;
      occurrences.set(profile.id, occurrence + 1);
      return { ...profile, apiKey: transform(profile.apiKey, JSON.stringify([profile.id, occurrence])) };
    })
  };
}

function decodeProfilesSecrets(raw: ProfilesFile): {
  file: ProfilesFile;
  originals: Map<string, OriginalKey>;
} {
  // Track the original slot so equal plaintext keys don't swap envelopes or
  // allow a legacy plaintext key to be copied to a new profile without a backend.
  const originals = new Map<string, OriginalKey>();
  const file = transformProfileKeys(raw, (apiKey, slot) => {
    const plaintext = isSecretEnvelope(apiKey) ? decryptSecret(apiKey) : apiKey;
    if (plaintext === null) return apiKey;
    originals.set(slot, { plaintext, onDisk: apiKey });
    return plaintext;
  });
  return { file, originals };
}

function encodeProfilesSecrets(
  file: ProfilesFile,
  originals: Map<string, OriginalKey>,
  storageAvailable: boolean
): ProfilesFile {
  return transformProfileKeys(file, (apiKey, slot) => {
    const original = originals.get(slot);
    if (original?.plaintext === apiKey && isSecretEnvelope(original.onDisk)) return original.onDisk;
    if (!apiKey || isSecretEnvelope(apiKey)) return apiKey;
    if (storageAvailable) return encryptSecret(apiKey);
    if (original?.plaintext === apiKey) return original.onDisk;
    throw new SecureStorageUnavailableError();
  });
}

async function loadRawProfilesFile(): Promise<ProfilesFile | null> {
  try {
    const content = await fs.readFile(getProfilesFilePath(), 'utf-8');
    const data = JSON.parse(content);
    return isValidProfilesFile(data) ? data : null;
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Load profiles.json from disk, decrypting any keys that can be decrypted.
 * Returns default empty profiles file if file doesn't exist or is corrupted.
 */
export async function loadProfilesFile(): Promise<ProfilesFile> {
  try {
    const raw = await loadRawProfilesFile();
    return raw ? decodeProfilesSecrets(raw).file : getDefaultProfilesFile();
  } catch {
    return getDefaultProfilesFile();
  }
}

/** Replace profiles.json using the same lock and owner-only write as a profile edit. */
export async function saveProfilesFile(data: ProfilesFile): Promise<void> {
  await atomicModifyProfiles(() => data);
}

function hasLegacyPlaintext(raw: ProfilesFile | null): boolean {
  return raw?.profiles.some(({ apiKey }) => !!apiKey && !isSecretEnvelope(apiKey)) ?? false;
}

/** Attempt to encrypt legacy plaintext without disturbing the file on failure. */
export async function migrateProfilesSecrets(): Promise<void> {
  try {
    if (!isSecureStorageAvailable() || !hasLegacyPlaintext(await loadRawProfilesFile())) return;
    await atomicModifyProfiles((file) => file, { migrateOnly: true });
  } catch {
    // Never log the cause: it may contain sensitive data.
    console.warn('[ProfileStore] Failed to migrate API profile secrets');
  }
}

/**
 * Generate a unique UUID v4 for a new profile
 */
export function generateProfileId(): string {
  // Use crypto.randomUUID() if available (Node.js 16+ and modern browsers)
  // Fall back to hand-rolled implementation for older environments
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  // Fallback: hand-rolled UUID v4 implementation
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Validate and set file permissions to user-readable only
 * Returns true if successful, false otherwise
 */
export async function validateFilePermissions(filePath: string): Promise<boolean> {
  try {
    // Set file permissions to user-readable only (0600)
    await fs.chmod(filePath, 0o600);
    return true;
  } catch {
    return false;
  }
}

/**
 * Execute a function with exclusive file lock to prevent race conditions
 * This ensures atomic read-modify-write operations on the profiles file
 *
 * @param fn Function to execute while holding the lock
 * @returns Result of the function execution
 */
export async function withProfilesLock<T>(fn: () => Promise<T>): Promise<T> {
  const filePath = getProfilesFilePath();
  const dir = path.dirname(filePath);

  // Ensure directory and file exist before trying to lock
  await fs.mkdir(dir, { recursive: true });

  // Create file if it doesn't exist (needed for lockfile to work)
  try {
    await fs.access(filePath);
  } catch {
    // File doesn't exist, create it atomically with exclusive flag
    const defaultData = getDefaultProfilesFile();
    try {
      await fs.writeFile(filePath, JSON.stringify(defaultData, null, 2), { encoding: 'utf-8', flag: 'wx' });
    } catch (err: unknown) {
      // If file was created by another process (race condition), that's fine
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
      // EEXIST means another process won the race, proceed normally
    }
  }

  // Acquire lock with reasonable timeout
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(filePath, {
      retries: {
        retries: 10,
        minTimeout: 50,
        maxTimeout: 500
      }
    });

    // Execute the function while holding the lock
    return await fn();
  } finally {
    // Always release the lock
    if (release) {
      await release();
    }
  }
}

/**
 * Set the active API profile by ID
 * This atomically updates the activeProfileId in profiles.json
 *
 * @param profileId - The profile ID to set as active, or null to clear
 * @returns The updated ProfilesFile
 */
export async function setActiveAPIProfile(profileId: string | null): Promise<ProfilesFile> {
  return await atomicModifyProfiles((file) => {
    // Validate that the profile exists if setting an ID
    if (profileId !== null) {
      const profile = file.profiles.find(p => p.id === profileId);
      if (!profile) {
        throw new Error(`API profile not found: ${profileId}`);
      }
    }
    return {
      ...file,
      activeProfileId: profileId
    };
  });
}

/**
 * Atomically modify the profiles file
 * Loads, modifies, and saves the file within an exclusive lock
 *
 * @param modifier Function that modifies the ProfilesFile
 * @param options Restrict a migration to files that still have legacy keys under the lock
 * @returns The modified ProfilesFile
 */
export async function atomicModifyProfiles(
  modifier: (file: ProfilesFile) => ProfilesFile | Promise<ProfilesFile>,
  { migrateOnly = false }: { migrateOnly?: boolean } = {}
): Promise<ProfilesFile> {
  return await withProfilesLock(async () => {
    const raw = await loadRawProfilesFile();
    const { file, originals } = decodeProfilesSecrets(raw ?? getDefaultProfilesFile());

    // Recheck on the locked snapshot in case the file changed after preflight.
    if (migrateOnly && !hasLegacyPlaintext(raw)) return file;
    const modifiedFile = await modifier(file);
    const storageAvailable = isSecureStorageAvailable();
    if (migrateOnly && !storageAvailable) return file;
    const content = JSON.stringify(encodeProfilesSecrets(modifiedFile, originals, storageAvailable), null, 2);

    // Save atomically (write to temp file and rename)
    const filePath = getProfilesFilePath();
    const tempPath = `${filePath}.tmp`;

    try {
      await fs.writeFile(tempPath, content, { encoding: 'utf-8', mode: 0o600 });

      if (!(await validateFilePermissions(tempPath))) {
        throw new Error('Failed to set secure file permissions on profiles file');
      }

      // Atomically replace original file
      await fs.rename(tempPath, filePath);

      return modifiedFile;
    } catch (error) {
      // Clean up temp file on error
      try {
        await fs.unlink(tempPath);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  });
}
