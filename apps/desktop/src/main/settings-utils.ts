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
 * NOTE: This module intentionally does NOT perform migrations or auto-detection.
 * Those are handled by the IPC handlers where they have full context.
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
import type { AppSettings } from '../shared/types/settings';

/**
 * Get the path to the settings file
 */
export function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

/**
 * Read and parse settings from disk.
 * Returns the raw on-disk subset of settings (Partial<AppSettings>, not validated), or undefined if the file doesn't exist or fails to parse.
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
    return JSON.parse(content);
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
 * @param settings - The settings object to write
 */
export function writeSettingsFile(settings: Record<string, unknown>): void {
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
 * Returns the raw on-disk subset of settings (Partial<AppSettings>, not validated), or undefined if the file doesn't exist or fails to parse.
 *
 * This is the non-blocking version of readSettingsFile, safe to use in Electron main process
 * without blocking the event loop.
 *
 * This function does NOT merge with defaults or perform any migrations.
 * Callers are responsible for merging with DEFAULT_APP_SETTINGS.
 */
export async function readSettingsFileAsync(): Promise<Partial<AppSettings> | undefined> {
  const settingsPath = getSettingsPath();

  try {
    // Read directly — no separate access() check to avoid TOCTOU race
    const content = await fsPromises.readFile(settingsPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    // Return undefined if file doesn't exist or has parse errors — caller will use defaults
    return undefined;
  }
}
