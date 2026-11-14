/**
 * Credential target/service naming, path validation and token format helpers.
 */

import { createHash } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';
import { isWindows } from '../../platform';
import { isVerbose } from './types';

// Defense-in-depth: Pattern for valid credential target names
// Matches "Claude Code-credentials" or "Claude Code-credentials-{8 hex chars}"
export const VALID_TARGET_NAME_PATTERN = /^Claude Code-credentials(-[a-f0-9]{8})?$/;

/**
 * Validate that a credential target name matches the expected format.
 * Defense-in-depth check to prevent injection attacks.
 *
 * @param targetName - The target name to validate
 * @returns true if valid, false otherwise
 */
export function isValidTargetName(targetName: string): boolean {
  return VALID_TARGET_NAME_PATTERN.test(targetName);
}

/**
 * Validate that a credentials path is within expected boundaries.
 * Defense-in-depth check to prevent path traversal attacks.
 *
 * @param credentialsPath - The path to validate
 * @returns true if valid, false otherwise
 */
export function isValidCredentialsPath(credentialsPath: string): boolean {
  // Credentials path should:
  // 1. Not contain path traversal sequences (works on both Unix and Windows)
  // 2. End with the expected file name
  // Note: We allow custom config directories since they come from user settings
  // The configDir is from profile settings, which is trusted user input
  return (
    !credentialsPath.includes('..') &&
    credentialsPath.endsWith('.credentials.json')
  );
}

/**
 * Calculate the credential storage identifier suffix for a config directory.
 * Claude Code uses SHA256 hash of the config dir path, taking first 8 hex chars.
 *
 * @param configDir - The CLAUDE_CONFIG_DIR path
 * @returns The 8-character hex hash suffix
 */
export function calculateConfigDirHash(configDir: string): string {
  return createHash('sha256').update(configDir).digest('hex').slice(0, 8);
}

/**
 * Normalize Windows path separators for hash consistency with Claude CLI.
 *
 * Claude CLI on Windows uses backslashes, so we must too for hash consistency.
 * Mixed slashes (C:\Users\bill/.claude-profiles) produce different hashes than
 * consistent slashes (C:\Users\bill\.claude-profiles).
 *
 * Supports:
 * - Drive letter paths: C:\Users\...
 * - UNC paths with backslashes: \\server\share
 * - UNC paths with forward slashes: //server/share (normalized to \\server\share)
 *
 * @param path - The path to normalize
 * @returns The path with forward slashes replaced by backslashes on Windows
 */
export function normalizeWindowsPath(path: string): string {
  if (!isWindows()) return path;
  // Match: drive letter (C:), UNC with backslashes (\\), or UNC with forward slashes (//)
  if (!/^[A-Za-z]:|^[\\/]{2}/.test(path)) return path;
  return path.replace(/\//g, '\\');
}

/**
 * Get the Keychain service name for a config directory (macOS).
 *
 * All profiles use hash-based keychain entries for isolation.
 * This prevents interference with external Claude Code CLI which uses
 * "Claude Code-credentials" (no hash) for ~/.claude.
 *
 * @param configDir - CLAUDE_CONFIG_DIR path. Required for isolation.
 * @returns The Keychain service name (e.g., "Claude Code-credentials-d74c9506")
 */
export function getKeychainServiceName(configDir?: string): string {
  // No configDir provided - this should not happen with isolated profiles
  // Fall back to unhashed name for backwards compatibility during migration
  if (!configDir) {
    if (isVerbose) {
      console.warn('[CredentialUtils] getKeychainServiceName called without configDir - using legacy fallback');
    }
    return 'Claude Code-credentials';
  }

  // Normalize the configDir: expand ~ and resolve to absolute path
  const normalizedConfigDir = normalizeWindowsPath(
    configDir.startsWith('~')
      ? join(homedir(), configDir.slice(1))
      : configDir
  );

  // ALL profiles now use hash-based keychain entries for isolation
  // This prevents interference with external Claude Code CLI
  const hash = calculateConfigDirHash(normalizedConfigDir);
  return `Claude Code-credentials-${hash}`;
}

/**
 * Get the Windows Credential Manager target name for a config directory.
 *
 * @param configDir - Optional CLAUDE_CONFIG_DIR path. If not provided, returns default target name.
 * @returns The Credential Manager target name (e.g., "Claude Code-credentials-d74c9506")
 */
export function getWindowsCredentialTarget(configDir?: string): string {
  // Windows uses the same naming convention as macOS Keychain
  return getKeychainServiceName(configDir);
}

/**
 * Validate token format
 * Use 'sk-ant-' prefix to support future token format versions (oat02, oat03, etc.)
 */
export function isValidTokenFormat(token: string): boolean {
  return token.startsWith('sk-ant-');
}
