/**
 * Shared settings utilities for main process
 *
 * This module provides low-level settings file operations used by both
 * the main process startup (index.ts) and the IPC handlers (settings-handlers.ts).
 *
 * Guarantees: settings.json is written atomically (temp file + fsync + rename)
 * and is readable/writable by the owner only (0o600), since it may hold
 * credentials such as API keys.
 *
 * zeenha fork: API keys are encrypted at the persistence boundary. New keys
 * have no plaintext fallback; existing plaintext is preserved if secure storage
 * is unavailable, and session-only credentials are never written to disk.
 *
 * Read-modify-write goes through updateSettingsFile, which serializes callers
 * in-process and takes a cross-process proper-lockfile lock so concurrent
 * updates are never lost. If settings.json exists but is unreadable (corrupt,
 * or not a JSON object) it is never overwritten: SettingsUnreadableError is
 * thrown and the file is left untouched.
 *
 * Only at-rest key migration is handled here. Other migrations and
 * auto-detection are handled by the IPC handlers.
 */

import { app } from 'electron';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
// @ts-expect-error - no types available for proper-lockfile
import * as lockfile from 'proper-lockfile';
import type { AppSettings } from '../shared/types/settings';
import { isSecureStorageAvailable } from './secure-storage/secret-storage';
import { decodeSettingsSecrets, encodeSettingsSecrets } from './secure-storage/settings-secrets';

function isSettingsObject(value: unknown): value is Partial<AppSettings> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeSettingsFileContent(content: string): Partial<AppSettings> | undefined {
  const parsed: unknown = JSON.parse(content);
  return isSettingsObject(parsed) ? decodeSettingsSecrets(parsed).settings : undefined;
}

/**
 * Get the path to the settings file
 */
export function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

/**
 * Read and parse settings from disk.
 * Returns the settings subset with credentials decoded, or undefined if the
 * file is missing or invalid.
 *
 * This function does NOT merge with defaults or perform any migrations.
 * Callers are responsible for merging with DEFAULT_APP_SETTINGS.
 */
export function readSettingsFile(): Partial<AppSettings> | undefined {
  const settingsPath = getSettingsPath();

  if (!existsSync(settingsPath)) {
    return undefined;
  }

  try {
    const content = readFileSync(settingsPath, 'utf-8');
    return decodeSettingsFileContent(content);
  } catch {
    // Return undefined on parse error - caller will use defaults
    return undefined;
  }
}

/**
 * Write settings to disk atomically with owner-only permissions.
 *
 * The data is written to a unique temp file (mode 0o600) in the same directory,
 * fsynced, then renamed over settings.json. A failed write never leaves a
 * truncated settings.json or a stray temp file behind; the error is rethrown.
 *
 * @param settings - An already-encoded settings object. Call updateSettingsFile
 * for normal mutations so plaintext credentials never reach this raw writer.
 */
export function writeSettingsFile(settings: object): void {
  const settingsPath = getSettingsPath();

  // Ensure the directory exists
  const dir = path.dirname(settingsPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const tmpPath = `${settingsPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    const data = JSON.stringify(settings, null, 2);
    const fd = openSync(tmpPath, 'w', 0o600);
    try {
      writeSync(fd, data, 0, 'utf-8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Guard against umask quirks; no-op on platforms without POSIX modes
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, settingsPath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Temp file may not exist; ignore
    }
    throw error;
  }
}

/**
 * Thrown by updateSettingsFile when settings.json exists but cannot be read or
 * is not a JSON object. The file is left untouched so the user's data is not
 * overwritten with a partial settings object.
 */
export class SettingsUnreadableError extends Error {
  readonly code = 'SETTINGS_UNREADABLE';

  constructor(settingsPath: string, cause?: unknown) {
    super(`settings.json at ${settingsPath} is unreadable or not a JSON object; the file was left untouched`);
    this.name = 'SettingsUnreadableError';
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

// In-process queue: proper-lockfile throws ELOCKED for same-process contenders
// instead of queueing them, so serialize callers here first.
let updateQueue: Promise<unknown> = Promise.resolve();

/**
 * Read-modify-write settings.json under a cross-process lock.
 *
 * The mutator receives decoded settings (or {} if the file does not exist)
 * and may mutate them in place. If the serialized disk representation is unchanged,
 * nothing is written. If settings.json is unreadable, SettingsUnreadableError
 * is thrown and the file is not touched. If the mutator or the codec throws,
 * nothing is written. The lock is always released.
 *
 * @returns The mutator's return value
 */
export async function updateSettingsFile<T = void>(
  mutator: (settings: Partial<AppSettings>) => T | Promise<T>
): Promise<T> {
  const { result } = await runSettingsUpdate(mutator);
  return result;
}

// Report whether the file changed from inside the lock, so migration doesn't
// need to do an unlocked read or compare file metadata.
function runSettingsUpdate<T>(
  mutator: (settings: Partial<AppSettings>) => T | Promise<T>
): Promise<{ result: T; written: boolean }> {
  const run = async () => {
    const settingsPath = getSettingsPath();
    await fsPromises.mkdir(path.dirname(settingsPath), { recursive: true });

    const release: () => Promise<void> = await lockfile.lock(settingsPath, {
      realpath: false,
      retries: { retries: 10, minTimeout: 50, maxTimeout: 500 },
    });
    try {
      let raw: Partial<AppSettings> = {};
      if (existsSync(settingsPath)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(await fsPromises.readFile(settingsPath, 'utf-8'));
        } catch (error) {
          // zeenha fork: a JSON parser error can quote a credential from the file.
          throw new SettingsUnreadableError(settingsPath, error instanceof SyntaxError ? undefined : error);
        }
        if (!isSettingsObject(parsed)) {
          throw new SettingsUnreadableError(settingsPath);
        }
        raw = parsed;
      }

      const { settings, legacyPlaintext } = decodeSettingsSecrets(raw);
      const result = await mutator(settings);
      let written = false;
      encodeSettingsSecrets(settings, legacyPlaintext, (encoded) => {
        if (JSON.stringify(encoded) !== JSON.stringify(raw)) {
          writeSettingsFile(encoded);
          written = true;
        }
      });
      return { result, written };
    } finally {
      try {
        await release();
      } catch {
        // Lock may already be gone; nothing more to do
      }
    }
  };

  const next = updateQueue.then(run, run);
  updateQueue = next.catch(() => undefined);
  return next;
}

/** Migrate legacy plaintext keys under the normal settings lock. Never throws. */
export async function migrateSettingsSecrets(): Promise<'migrated' | 'unchanged' | 'skipped-no-backend' | 'failed'> {
  try {
    if (!isSecureStorageAvailable()) return 'skipped-no-backend';
    // Re-encoding the locked snapshot is enough to migrate legacy plaintext.
    const { written } = await runSettingsUpdate(() => undefined);
    return written ? 'migrated' : 'unchanged';
  } catch {
    console.warn('[Settings] Could not migrate stored credentials; settings.json was left unchanged');
    return 'failed';
  }
}

/**
 * Tighten an existing settings.json to owner-only (0o600).
 * Migration for files created earlier with default permissions.
 * Never throws: a missing file or unsupported platform is ignored.
 */
export function secureSettingsFilePermissions(): void {
  try {
    chmodSync(getSettingsPath(), 0o600);
  } catch {
    // ENOENT or chmod unsupported on this platform; nothing to do
  }
}

/**
 * Read and parse settings from disk asynchronously.
 * Returns the settings subset with credentials decoded, or undefined if the
 * file is missing or invalid.
 *
 * This version of readSettingsFile uses asynchronous file I/O.
 *
 * This function does NOT merge with defaults or perform any migrations.
 * Callers are responsible for merging with DEFAULT_APP_SETTINGS.
 */
export async function readSettingsFileAsync(): Promise<Partial<AppSettings> | undefined> {
  const settingsPath = getSettingsPath();

  try {
    // Read directly — no separate access() check to avoid TOCTOU race
    const content = await fsPromises.readFile(settingsPath, 'utf-8');
    return decodeSettingsFileContent(content);
  } catch {
    // Return undefined if file doesn't exist or has parse errors — caller will use defaults
    return undefined;
  }
}
