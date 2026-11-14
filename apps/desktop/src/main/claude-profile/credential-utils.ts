/**
 * Cross-Platform Credential Utilities (facade)
 *
 * Retrieves, updates and caches Claude Code OAuth credentials from
 * platform-specific secure storage:
 * - macOS: Keychain (via `security` command)
 * - Linux: Secret Service API (via `secret-tool`), with a file-based fallback
 * - Windows: Credential Manager (via PowerShell) and the CLI's credentials file
 *
 * Layout: the platform implementations live in ./credentials/
 * (types, cache, naming, parsing, macos, linux, windows-read, windows-update,
 * file-credentials). This file keeps the public API (same names and signatures
 * as before), the platform dispatchers, cache clearing and the subscription
 * metadata helper.
 *
 * Supports both:
 * - Default profile: "Claude Code-credentials" service / default config dir
 * - Custom profiles: "Claude Code-credentials-{sha256-8-hash}" where hash is first 8 chars
 *   of SHA256 hash of the CLAUDE_CONFIG_DIR path
 */

import { isMacOS, isWindows, isLinux } from '../platform';
import { credentialCache } from './credentials/cache';
import { getCredentialsFromMacOSKeychain, getFullCredentialsFromMacOSKeychain, updateMacOSKeychainCredentials } from './credentials/macos';
import { getCredentialsFromLinux, getFullCredentialsFromLinux, getLinuxCredentialsPath, getSecretServiceAttribute, updateLinuxCredentials } from './credentials/linux';
import { getCredentialsFromWindows, getFullCredentialsFromWindows, getWindowsCredentialsPath } from './credentials/windows-read';
import { updateWindowsCredentials } from './credentials/windows-update';
import { calculateConfigDirHash, getKeychainServiceName, getWindowsCredentialTarget, normalizeWindowsPath } from './credentials/naming';
import type { FullOAuthCredentials, KeychainCredentials, PlatformCredentials, UpdateCredentialsResult } from './credentials/types';

export type { FullOAuthCredentials, KeychainCredentials, PlatformCredentials, UpdateCredentialsResult };
export { calculateConfigDirHash, getKeychainServiceName, getWindowsCredentialTarget, normalizeWindowsPath };

// =============================================================================
// Cross-Platform Public API
// =============================================================================

/**
 * Retrieve Claude Code OAuth credentials (token and email) from platform-specific
 * secure storage.
 *
 * - macOS: Reads from Keychain
 * - Linux: Tries Secret Service (via secret-tool), falls back to .credentials.json
 * - Windows: Checks both .credentials.json and Credential Manager, prefers file
 *
 * For default profile: reads from "Claude Code-credentials" or default config dir
 * For custom profiles: uses SHA256(configDir).slice(0,8) hash suffix
 *
 * Uses caching (5-minute TTL) to avoid repeated blocking calls.
 *
 * @param configDir - Optional CLAUDE_CONFIG_DIR path for custom profiles
 * @param forceRefresh - Set to true to bypass cache and fetch fresh credentials
 * @returns Object with token and email (both may be null if not found or invalid)
 */
export function getCredentialsFromKeychain(configDir?: string, forceRefresh = false): PlatformCredentials {
  if (isMacOS()) {
    return getCredentialsFromMacOSKeychain(configDir, forceRefresh);
  }

  if (isLinux()) {
    return getCredentialsFromLinux(configDir, forceRefresh);
  }

  if (isWindows()) {
    return getCredentialsFromWindows(configDir, forceRefresh);
  }

  // Unknown platform - return empty
  return { token: null, email: null, error: `Unsupported platform: ${process.platform}` };
}

/**
 * Alias for getCredentialsFromKeychain for semantic clarity on non-macOS platforms
 */
export const getCredentials = getCredentialsFromKeychain;

/**
 * Clear the credentials cache for a specific profile or all profiles.
 * Useful when you know the credentials have changed (e.g., after running claude /login)
 *
 * @param configDir - Optional config dir to clear cache for specific profile. If not provided, clears all.
 */
export function clearKeychainCache(configDir?: string): void {
  if (configDir) {
    // Clear cache for this specific configDir on all platforms
    const macOSKey = `macos:${getKeychainServiceName(configDir)}`;
    const linuxSecretKey = `linux-secret:${getSecretServiceAttribute(configDir)}`;
    const linuxFileKey = `linux:${getLinuxCredentialsPath(configDir)}`;
    const windowsKey = `windows:${getWindowsCredentialTarget(configDir)}`;
    const windowsFileKey = `windows-file:${getWindowsCredentialsPath(configDir)}`;

    credentialCache.delete(macOSKey);
    credentialCache.delete(linuxSecretKey);
    credentialCache.delete(linuxFileKey);
    credentialCache.delete(windowsKey);
    credentialCache.delete(windowsFileKey);
  } else {
    credentialCache.clear();
  }
}

/**
 * Alias for clearKeychainCache for semantic clarity
 */
export const clearCredentialCache = clearKeychainCache;


/**
 * Get full credentials including refresh token and expiry from platform-specific secure storage.
 * This is an extended version of getCredentialsFromKeychain that returns all credential data
 * needed for token refresh operations.
 *
 * @param configDir - Optional config directory for profile-specific credentials
 * @returns Full credentials including refresh token and expiry information
 */
export function getFullCredentialsFromKeychain(configDir?: string): FullOAuthCredentials {
  if (isMacOS()) {
    return getFullCredentialsFromMacOSKeychain(configDir);
  }

  if (isLinux()) {
    return getFullCredentialsFromLinux(configDir);
  }

  if (isWindows()) {
    return getFullCredentialsFromWindows(configDir);
  }

  // Unknown platform - return empty
  return { token: null, email: null, refreshToken: null, expiresAt: null, scopes: null, subscriptionType: null, rateLimitTier: null, error: `Unsupported platform: ${process.platform}` };
}

/**
 * Update credentials in the platform-specific secure storage with new tokens.
 * Called after a successful OAuth token refresh to persist the new tokens.
 *
 * CRITICAL: This must be called immediately after token refresh because the old tokens
 * are revoked by Anthropic as soon as new tokens are issued.
 *
 * @param configDir - Config directory for the profile (undefined for default profile)
 * @param credentials - New credentials to store
 * @returns Result indicating success or failure
 */
export function updateKeychainCredentials(
  configDir: string | undefined,
  credentials: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes?: string[];
  }
): UpdateCredentialsResult {
  if (isMacOS()) {
    return updateMacOSKeychainCredentials(configDir, credentials);
  }

  if (isLinux()) {
    return updateLinuxCredentials(configDir, credentials);
  }

  if (isWindows()) {
    return updateWindowsCredentials(configDir, credentials);
  }

  return { success: false, error: `Unsupported platform: ${process.platform}` };
}

// =============================================================================
// Profile Subscription Metadata Helper
// =============================================================================

/**
 * Result of updating profile subscription metadata
 */
export interface UpdateSubscriptionMetadataResult {
  /** Whether subscriptionType was updated */
  subscriptionTypeUpdated: boolean;
  /** Whether rateLimitTier was updated */
  rateLimitTierUpdated: boolean;
  /** The subscriptionType value (if found) */
  subscriptionType?: string | null;
  /** The rateLimitTier value (if found) */
  rateLimitTier?: string | null;
}

/**
 * Options for updateProfileSubscriptionMetadata
 */
export interface UpdateSubscriptionMetadataOptions {
  /**
   * If true, only update fields that are currently missing (undefined/null/empty).
   * This is useful for migration/initialization code that should not overwrite existing values.
   * Default: false (always update if credentials have values)
   */
  onlyIfMissing?: boolean;
}

/**
 * Update a profile's subscription metadata (subscriptionType, rateLimitTier) from Keychain credentials.
 *
 * This helper centralizes the common pattern of reading subscription info from Keychain
 * and updating a profile object. It's used after OAuth login, onboarding completion,
 * and profile authentication verification.
 *
 * NOTE: This function mutates the profile object directly. The caller is responsible
 * for saving the profile after calling this function.
 *
 * @param profile - The profile object to update (must have subscriptionType and rateLimitTier properties)
 * @param configDirOrCredentials - Either a config directory path to read credentials from,
 *                                  or pre-fetched FullOAuthCredentials to avoid redundant reads
 * @param options - Optional settings like onlyIfMissing
 * @returns Information about what was updated
 *
 * @example
 * ```typescript
 * // Option 1: Pass configDir - helper fetches credentials
 * const result = updateProfileSubscriptionMetadata(profile, profile.configDir);
 *
 * // Option 2: Pass pre-fetched credentials (more efficient when already fetched)
 * const fullCreds = getFullCredentialsFromKeychain(profile.configDir);
 * const result = updateProfileSubscriptionMetadata(profile, fullCreds);
 *
 * // Option 3: Only populate if missing (for migration/initialization)
 * const result = updateProfileSubscriptionMetadata(profile, profile.configDir, { onlyIfMissing: true });
 *
 * if (result.subscriptionTypeUpdated || result.rateLimitTierUpdated) {
 *   profileManager.saveProfile(profile);
 * }
 * ```
 */
export function updateProfileSubscriptionMetadata(
  profile: { subscriptionType?: string | null; rateLimitTier?: string | null },
  configDirOrCredentials: string | undefined | FullOAuthCredentials,
  options?: UpdateSubscriptionMetadataOptions
): UpdateSubscriptionMetadataResult {
  const result: UpdateSubscriptionMetadataResult = {
    subscriptionTypeUpdated: false,
    rateLimitTierUpdated: false,
  };

  const onlyIfMissing = options?.onlyIfMissing ?? false;

  // Determine if we received pre-fetched credentials or a configDir
  const fullCreds: FullOAuthCredentials =
    typeof configDirOrCredentials === 'object' && configDirOrCredentials !== null
      ? configDirOrCredentials
      : getFullCredentialsFromKeychain(configDirOrCredentials);

  // Update subscriptionType if credentials have it and (not onlyIfMissing OR profile doesn't have it)
  if (fullCreds.subscriptionType && (!onlyIfMissing || !profile.subscriptionType)) {
    profile.subscriptionType = fullCreds.subscriptionType;
    result.subscriptionTypeUpdated = true;
    result.subscriptionType = fullCreds.subscriptionType;
  }

  // Update rateLimitTier if credentials have it and (not onlyIfMissing OR profile doesn't have it)
  if (fullCreds.rateLimitTier && (!onlyIfMissing || !profile.rateLimitTier)) {
    profile.rateLimitTier = fullCreds.rateLimitTier;
    result.rateLimitTierUpdated = true;
    result.rateLimitTier = fullCreds.rateLimitTier;
  }

  return result;
}
