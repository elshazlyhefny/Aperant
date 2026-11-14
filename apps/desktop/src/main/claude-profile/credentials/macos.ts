/**
 * macOS Keychain credential storage.
 */

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { userInfo } from 'os';
import { CACHE_TTL_MS, ERROR_CACHE_TTL_MS, credentialCache } from './cache';
import { getKeychainServiceName, isValidTokenFormat } from './naming';
import {
  executeCredentialRead,
  extractCredentials,
  extractFullCredentials,
  getTokenFingerprint,
  parseCredentialJson,
} from './parsing';
import { MACOS_KEYCHAIN_TIMEOUT_MS, isVerbose } from './types';
import type { FullOAuthCredentials, PlatformCredentials, UpdateCredentialsResult } from './types';

/**
 * Retrieve credentials from macOS Keychain
 */
export function getCredentialsFromMacOSKeychain(configDir?: string, forceRefresh = false): PlatformCredentials {
  const serviceName = getKeychainServiceName(configDir);
  const cacheKey = `macos:${serviceName}`;
  const now = Date.now();

  // Return cached credentials if available and fresh
  const cached = credentialCache.get(cacheKey);
  if (!forceRefresh && cached) {
    const ttl = cached.credentials.error ? ERROR_CACHE_TTL_MS : CACHE_TTL_MS;
    if ((now - cached.timestamp) < ttl) {
      if (isVerbose) {
        const cacheAge = now - cached.timestamp;
        console.warn('[CredentialUtils:macOS:CACHE] Returning cached credentials:', {
          serviceName,
          hasToken: !!cached.credentials.token,
          tokenFingerprint: getTokenFingerprint(cached.credentials.token),
          cacheAge: Math.round(cacheAge / 1000) + 's'
        });
      }
      return cached.credentials;
    }
  }

  // Locate the security executable
  let securityPath: string | null = null;
  const candidatePaths = ['/usr/bin/security', '/bin/security'];

  for (const candidate of candidatePaths) {
    if (existsSync(candidate)) {
      securityPath = candidate;
      break;
    }
  }

  if (!securityPath) {
    const notFoundResult = { token: null, email: null, error: 'macOS security command not found' };
    credentialCache.set(cacheKey, { credentials: notFoundResult, timestamp: now });
    return notFoundResult;
  }

  try {
    // Query macOS Keychain for Claude Code credentials using shared helper
    const credentialsJson = executeCredentialRead(
      securityPath,
      ['find-generic-password', '-s', serviceName, '-w'],
      MACOS_KEYCHAIN_TIMEOUT_MS,
      `macOS:${serviceName}`
    );

    // Parse and validate using shared helper
    const { token, email } = parseCredentialJson(
      credentialsJson,
      `macOS:${serviceName}`,
      extractCredentials
    );

    // Validate token format if present
    if (token && !isValidTokenFormat(token)) {
      console.warn('[CredentialUtils:macOS] Invalid token format for service:', serviceName);
      const result = { token: null, email };
      credentialCache.set(cacheKey, { credentials: result, timestamp: now });
      return result;
    }

    const credentials = { token, email };
    credentialCache.set(cacheKey, { credentials, timestamp: now });

    if (isVerbose) {
      console.warn('[CredentialUtils:macOS] Retrieved credentials from Keychain for service:', serviceName, {
        hasToken: !!token,
        hasEmail: !!email,
        tokenFingerprint: getTokenFingerprint(token),
        forceRefresh
      });
    }
    return credentials;
  } catch (error) {
    // Unexpected error (executeCredentialRead already handles "not found" cases)
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn('[CredentialUtils:macOS] Keychain access failed for service:', serviceName, errorMessage);
    const errorResult = { token: null, email: null, error: `Keychain access failed: ${errorMessage}` };
    // Use shorter TTL for errors
    credentialCache.set(cacheKey, { credentials: errorResult, timestamp: now });
    return errorResult;
  }
}

/**
 * Retrieve full credentials (including refresh token) from macOS Keychain
 */
export function getFullCredentialsFromMacOSKeychain(configDir?: string): FullOAuthCredentials {
  const serviceName = getKeychainServiceName(configDir);

  // Locate the security executable
  let securityPath: string | null = null;
  const candidatePaths = ['/usr/bin/security', '/bin/security'];

  for (const candidate of candidatePaths) {
    if (existsSync(candidate)) {
      securityPath = candidate;
      break;
    }
  }

  if (!securityPath) {
    return { token: null, email: null, refreshToken: null, expiresAt: null, scopes: null, subscriptionType: null, rateLimitTier: null, error: 'macOS security command not found' };
  }

  try {
    // Query macOS Keychain for Claude Code credentials using shared helper
    const credentialsJson = executeCredentialRead(
      securityPath,
      ['find-generic-password', '-s', serviceName, '-w'],
      MACOS_KEYCHAIN_TIMEOUT_MS,
      `macOS:Full:${serviceName}`
    );

    // Parse and validate using shared helper
    const { token, email, refreshToken, expiresAt, scopes, subscriptionType, rateLimitTier } = parseCredentialJson(
      credentialsJson,
      `macOS:Full:${serviceName}`,
      extractFullCredentials
    );

    // Validate token format if present
    if (token && !isValidTokenFormat(token)) {
      console.warn('[CredentialUtils:macOS:Full] Invalid token format for service:', serviceName);
      return { token: null, email, refreshToken, expiresAt, scopes, subscriptionType, rateLimitTier };
    }

    if (isVerbose) {
      console.warn('[CredentialUtils:macOS:Full] Retrieved full credentials from Keychain for service:', serviceName, {
        hasToken: !!token,
        hasEmail: !!email,
        hasRefreshToken: !!refreshToken,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        tokenFingerprint: getTokenFingerprint(token),
        subscriptionType,
        rateLimitTier
      });
    }
    return { token, email, refreshToken, expiresAt, scopes, subscriptionType, rateLimitTier };
  } catch (error) {
    // Unexpected error (executeCredentialRead already handles "not found" cases)
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn('[CredentialUtils:macOS:Full] Keychain access failed for service:', serviceName, errorMessage);
    return { token: null, email: null, refreshToken: null, expiresAt: null, scopes: null, subscriptionType: null, rateLimitTier: null, error: `Keychain access failed: ${errorMessage}` };
  }
}

/**
 * Update credentials in macOS Keychain with new tokens
 */
export function updateMacOSKeychainCredentials(
  configDir: string | undefined,
  credentials: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes?: string[];
  }
): UpdateCredentialsResult {
  const serviceName = getKeychainServiceName(configDir);
  const isDebug = process.env.DEBUG === 'true';

  // Locate the security executable
  let securityPath: string | null = null;
  const candidatePaths = ['/usr/bin/security', '/bin/security'];

  for (const candidate of candidatePaths) {
    if (existsSync(candidate)) {
      securityPath = candidate;
      break;
    }
  }

  if (!securityPath) {
    return { success: false, error: 'macOS security command not found' };
  }

  try {
    // Read existing credentials to preserve email, subscriptionType, and rateLimitTier
    const existing = getFullCredentialsFromMacOSKeychain(configDir);

    // Build new credential JSON with all fields
    // IMPORTANT: Preserve subscriptionType and rateLimitTier from existing credentials
    // These fields determine "Max" vs "API" display in Claude Code and are NOT returned
    // by the OAuth token refresh endpoint - they must be preserved from the original auth.
    const newCredentialData = {
      claudeAiOauth: {
        accessToken: credentials.accessToken,
        refreshToken: credentials.refreshToken,
        expiresAt: credentials.expiresAt,
        scopes: credentials.scopes || existing.scopes || [],
        email: existing.email || undefined,
        emailAddress: existing.email || undefined,
        subscriptionType: existing.subscriptionType || undefined,
        rateLimitTier: existing.rateLimitTier || undefined
      },
      email: existing.email || undefined
    };

    const credentialsJson = JSON.stringify(newCredentialData);

    // CRITICAL FIX: The -U flag only updates if the account name matches exactly.
    // Claude Code CLI stores credentials with the system username as the account,
    // but we were using 'claude-ai-oauth'. This mismatch caused updates to create
    // a NEW entry instead of updating the existing one, leading to stale tokens.
    //
    // Solution: Delete any existing entry first, then add fresh.
    // This ensures we don't end up with multiple entries with different account names.

    // Step 1: Delete existing entry (ignore errors if not found)
    try {
      execFileSync(
        securityPath,
        ['delete-generic-password', '-s', serviceName],
        {
          encoding: 'utf-8',
          stdio: 'pipe',
          timeout: MACOS_KEYCHAIN_TIMEOUT_MS,
          windowsHide: true,
        }
      );
      if (isDebug) {
        console.warn('[CredentialUtils:macOS:Update] Deleted existing Keychain entry for service:', serviceName);
      }
    } catch {
      // Entry didn't exist - that's fine, we'll create it
      if (isDebug) {
        console.warn('[CredentialUtils:macOS:Update] No existing entry to delete for service:', serviceName);
      }
    }

    // Step 2: Add new entry with system username as account name
    // Claude Code CLI uses the system username, so we must match that for compatibility
    const accountName = userInfo().username;
    execFileSync(
      securityPath,
      ['add-generic-password', '-s', serviceName, '-a', accountName, '-w', credentialsJson],
      {
        encoding: 'utf-8',
        timeout: MACOS_KEYCHAIN_TIMEOUT_MS,
        windowsHide: true,
      }
    );

    if (isDebug) {
      console.warn('[CredentialUtils:macOS:Update] Successfully updated Keychain credentials for service:', serviceName);
    }

    // Clear cached credentials to ensure fresh values are read
    credentialCache.delete(`macos:${serviceName}`);

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[CredentialUtils:macOS:Update] Failed to update Keychain credentials:', errorMessage);
    return { success: false, error: `Keychain update failed: ${errorMessage}` };
  }
}
