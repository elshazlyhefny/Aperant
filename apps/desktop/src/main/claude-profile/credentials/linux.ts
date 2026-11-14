/**
 * Linux credential storage: Secret Service (secret-tool) with a
 * file-based fallback.
 */

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { CACHE_TTL_MS, ERROR_CACHE_TTL_MS, credentialCache } from './cache';
import { getCredentialsFromFile, getFullCredentialsFromFile } from './file-credentials';
import { isValidCredentialsPath, isValidTokenFormat } from './naming';
import {
  executeCredentialRead,
  extractCredentials,
  extractFullCredentials,
  getTokenFingerprint,
  parseCredentialJson,
} from './parsing';
import { LINUX_SECRET_TOOL_TIMEOUT_MS, isVerbose } from './types';
import type { FullOAuthCredentials, PlatformCredentials, UpdateCredentialsResult } from './types';

/**
 * Clear cached credentials after an update (mirrors clearKeychainCache for Linux keys).
 */
function clearLinuxCredentialCache(configDir?: string): void {
  if (configDir) {
    credentialCache.delete(`linux-secret:${getSecretServiceAttribute(configDir)}`);
    credentialCache.delete(`linux:${getLinuxCredentialsPath(configDir)}`);
  } else {
    credentialCache.clear();
  }
}

/**
 * Find secret-tool executable path on Linux
 */
function findSecretToolPath(): string | null {
  const candidatePaths = [
    '/usr/bin/secret-tool',
    '/bin/secret-tool',
    '/usr/local/bin/secret-tool',
  ];

  for (const candidate of candidatePaths) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Get the Secret Service attribute value for a config directory.
 * For default profile, uses "claude-code".
 * For custom profiles, uses "claude-code-{hash}" where hash is first 8 chars of SHA256.
 */
export function getSecretServiceAttribute(configDir?: string): string {
  if (!configDir) {
    return 'claude-code';
  }
  // For custom config dirs, create a hashed attribute to avoid conflicts
  const hash = createHash('sha256').update(configDir).digest('hex').slice(0, 8);
  return `claude-code-${hash}`;
}

/**
 * Retrieve credentials from Linux Secret Service using secret-tool CLI.
 *
 * Claude Code stores credentials in Secret Service with:
 * - Label: "Claude Code-credentials"
 * - Attributes: {application: "claude-code"}
 * - Secret: JSON string with claudeAiOauth.accessToken
 */
function getCredentialsFromLinuxSecretService(configDir?: string, forceRefresh = false): PlatformCredentials {
  const attribute = getSecretServiceAttribute(configDir);
  const cacheKey = `linux-secret:${attribute}`;
  const isDebug = process.env.DEBUG === 'true';
  const now = Date.now();

  // Return cached credentials if available and fresh
  const cached = credentialCache.get(cacheKey);
  if (!forceRefresh && cached) {
    const ttl = cached.credentials.error ? ERROR_CACHE_TTL_MS : CACHE_TTL_MS;
    if ((now - cached.timestamp) < ttl) {
      if (isVerbose) {
        const cacheAge = now - cached.timestamp;
        console.warn('[CredentialUtils:Linux:SecretService:CACHE] Returning cached credentials:', {
          attribute,
          hasToken: !!cached.credentials.token,
          tokenFingerprint: getTokenFingerprint(cached.credentials.token),
          cacheAge: Math.round(cacheAge / 1000) + 's'
        });
      }
      return cached.credentials;
    }
  }

  // Find secret-tool executable
  const secretToolPath = findSecretToolPath();
  if (!secretToolPath) {
    if (isDebug) {
      console.warn('[CredentialUtils:Linux:SecretService] secret-tool not found, falling back to file storage');
    }
    // Return a special result indicating Secret Service is unavailable
    return { token: null, email: null, error: 'secret-tool not found' };
  }

  try {
    // Query Secret Service for credentials using shared helper
    const credentialsJson = executeCredentialRead(
      secretToolPath,
      ['lookup', 'application', attribute],
      LINUX_SECRET_TOOL_TIMEOUT_MS,
      `Linux:SecretService:${attribute}`
    );

    // Parse and validate using shared helper
    const { token, email } = parseCredentialJson(
      credentialsJson,
      `Linux:SecretService:${attribute}`,
      extractCredentials
    );

    // Validate token format if present
    if (token && !isValidTokenFormat(token)) {
      console.warn('[CredentialUtils:Linux:SecretService] Invalid token format for attribute:', attribute);
      const result = { token: null, email };
      credentialCache.set(cacheKey, { credentials: result, timestamp: now });
      return result;
    }

    const credentials = { token, email };
    credentialCache.set(cacheKey, { credentials, timestamp: now });

    if (isVerbose) {
      console.warn('[CredentialUtils:Linux:SecretService] Retrieved credentials from Secret Service:', {
        attribute,
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
    console.warn('[CredentialUtils:Linux:SecretService] Secret Service access failed:', errorMessage);
    // Return error to trigger fallback to file storage
    return { token: null, email: null, error: `Secret Service access failed: ${errorMessage}` };
  }
}

/**
 * Retrieve credentials from Linux - tries Secret Service first, falls back to file
 */
export function getCredentialsFromLinux(configDir?: string, forceRefresh = false): PlatformCredentials {
  const isDebug = process.env.DEBUG === 'true';

  // Try Secret Service first (preferred secure storage)
  const secretServiceResult = getCredentialsFromLinuxSecretService(configDir, forceRefresh);

  // If we got a token from Secret Service, use it
  if (secretServiceResult.token) {
    return secretServiceResult;
  }

  // If Secret Service had an error (not just "not found"), log it and try file fallback
  if (secretServiceResult.error && !secretServiceResult.error.includes('not found')) {
    if (isDebug) {
      console.warn('[CredentialUtils:Linux] Secret Service unavailable, trying file fallback:', secretServiceResult.error);
    }
  }

  // Fall back to file-based storage
  return getCredentialsFromLinuxFile(configDir, forceRefresh);
}

// =============================================================================
// Linux Credentials File Implementation (Fallback)
// =============================================================================

/**
 * Get the credentials file path for Linux
 */
export function getLinuxCredentialsPath(configDir?: string): string {
  const baseDir = configDir || join(homedir(), '.claude');
  return join(baseDir, '.credentials.json');
}

/**
 * Retrieve credentials from Linux .credentials.json file (fallback when Secret Service unavailable)
 */
function getCredentialsFromLinuxFile(configDir?: string, forceRefresh = false): PlatformCredentials {
  const credentialsPath = getLinuxCredentialsPath(configDir);
  const cacheKey = `linux:${credentialsPath}`;
  return getCredentialsFromFile(credentialsPath, cacheKey, 'Linux', forceRefresh);
}

/**
 * Retrieve full credentials (including refresh token) from Linux Secret Service
 */
function getFullCredentialsFromLinuxSecretService(configDir?: string): FullOAuthCredentials {
  const attribute = getSecretServiceAttribute(configDir);
  const isDebug = process.env.DEBUG === 'true';

  // Find secret-tool executable
  const secretToolPath = findSecretToolPath();
  if (!secretToolPath) {
    if (isDebug) {
      console.warn('[CredentialUtils:Linux:SecretService:Full] secret-tool not found');
    }
    return { token: null, email: null, refreshToken: null, expiresAt: null, scopes: null, subscriptionType: null, rateLimitTier: null, error: 'secret-tool not found' };
  }

  try {
    // Query Secret Service for credentials using shared helper
    const credentialsJson = executeCredentialRead(
      secretToolPath,
      ['lookup', 'application', attribute],
      LINUX_SECRET_TOOL_TIMEOUT_MS,
      `Linux:SecretService:Full:${attribute}`
    );

    // Parse and validate using shared helper
    const { token, email, refreshToken, expiresAt, scopes, subscriptionType, rateLimitTier } = parseCredentialJson(
      credentialsJson,
      `Linux:SecretService:Full:${attribute}`,
      extractFullCredentials
    );

    if (token && !isValidTokenFormat(token)) {
      console.warn('[CredentialUtils:Linux:SecretService:Full] Invalid token format for attribute:', attribute);
      return { token: null, email, refreshToken, expiresAt, scopes, subscriptionType, rateLimitTier };
    }

    if (isVerbose) {
      console.warn('[CredentialUtils:Linux:SecretService:Full] Retrieved full credentials from Secret Service:', {
        attribute,
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
    console.warn('[CredentialUtils:Linux:SecretService:Full] Secret Service access failed:', errorMessage);
    return { token: null, email: null, refreshToken: null, expiresAt: null, scopes: null, subscriptionType: null, rateLimitTier: null, error: `Secret Service access failed: ${errorMessage}` };
  }
}

/**
 * Retrieve full credentials from Linux - tries Secret Service first, falls back to file
 */
export function getFullCredentialsFromLinux(configDir?: string): FullOAuthCredentials {
  const isDebug = process.env.DEBUG === 'true';

  // Try Secret Service first
  const secretServiceResult = getFullCredentialsFromLinuxSecretService(configDir);

  if (secretServiceResult.token) {
    return secretServiceResult;
  }

  if (secretServiceResult.error && !secretServiceResult.error.includes('not found')) {
    if (isDebug) {
      console.warn('[CredentialUtils:Linux:Full] Secret Service unavailable, trying file fallback:', secretServiceResult.error);
    }
  }

  // Fall back to file-based storage
  return getFullCredentialsFromLinuxFile(configDir);
}

/**
 * Retrieve full credentials (including refresh token) from Linux .credentials.json file (fallback)
 */
function getFullCredentialsFromLinuxFile(configDir?: string): FullOAuthCredentials {
  const credentialsPath = getLinuxCredentialsPath(configDir);
  return getFullCredentialsFromFile(credentialsPath, 'Linux:Full');
}

/**
 * Update credentials in Linux Secret Service with new tokens
 */
function updateLinuxSecretServiceCredentials(
  configDir: string | undefined,
  credentials: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes?: string[];
  }
): UpdateCredentialsResult {
  const attribute = getSecretServiceAttribute(configDir);
  const isDebug = process.env.DEBUG === 'true';

  // Find secret-tool executable
  const secretToolPath = findSecretToolPath();
  if (!secretToolPath) {
    if (isDebug) {
      console.warn('[CredentialUtils:Linux:SecretService:Update] secret-tool not found');
    }
    return { success: false, error: 'secret-tool not found' };
  }

  try {
    // Read existing credentials to preserve email, subscriptionType, and rateLimitTier
    const existing = getFullCredentialsFromLinuxSecretService(configDir);

    // Build new credential JSON with all fields
    // IMPORTANT: Preserve subscriptionType and rateLimitTier from existing credentials
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

    // Use secret-tool store to update credentials
    // secret-tool store --label="Claude Code-credentials" application claude-code
    execFileSync(
      secretToolPath,
      ['store', '--label=Claude Code-credentials', 'application', attribute],
      {
        encoding: 'utf-8',
        timeout: LINUX_SECRET_TOOL_TIMEOUT_MS,
        input: credentialsJson,
        windowsHide: true,
      }
    );

    if (isDebug) {
      console.warn('[CredentialUtils:Linux:SecretService:Update] Successfully updated Secret Service credentials for attribute:', attribute);
    }

    // Clear cached credentials to ensure fresh values are read
    clearLinuxCredentialCache(configDir);

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[CredentialUtils:Linux:SecretService:Update] Failed to update Secret Service credentials:', errorMessage);
    return { success: false, error: `Secret Service update failed: ${errorMessage}` };
  }
}

/**
 * Update credentials in Linux - tries Secret Service first, falls back to file
 */
export function updateLinuxCredentials(
  configDir: string | undefined,
  credentials: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes?: string[];
  }
): UpdateCredentialsResult {
  const isDebug = process.env.DEBUG === 'true';

  // Try Secret Service first
  const secretToolPath = findSecretToolPath();
  if (secretToolPath) {
    const secretServiceResult = updateLinuxSecretServiceCredentials(configDir, credentials);
    if (secretServiceResult.success) {
      return secretServiceResult;
    }
    if (isDebug) {
      console.warn('[CredentialUtils:Linux:Update] Secret Service update failed, trying file fallback:', secretServiceResult.error);
    }
  }

  // Fall back to file-based storage
  return updateLinuxFileCredentials(configDir, credentials);
}

/**
 * Update credentials in Linux .credentials.json file with new tokens (fallback)
 */
function updateLinuxFileCredentials(
  configDir: string | undefined,
  credentials: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes?: string[];
  }
): UpdateCredentialsResult {
  const credentialsPath = getLinuxCredentialsPath(configDir);
  const isDebug = process.env.DEBUG === 'true';


  // Defense-in-depth: Validate credentials path
  if (!isValidCredentialsPath(credentialsPath)) {
    return { success: false, error: 'Invalid credentials path' };
  }

  try {
    // Read existing credentials to preserve email, subscriptionType, and rateLimitTier
    const existing = getFullCredentialsFromLinuxFile(configDir);

    // Build new credential JSON with all fields
    // IMPORTANT: Preserve subscriptionType and rateLimitTier from existing credentials
    // CodeQL: network data validated before write - validate token fields are expected types before writing
    const newCredentialData = {
      claudeAiOauth: {
        accessToken: typeof credentials.accessToken === 'string' ? credentials.accessToken : '',
        refreshToken: typeof credentials.refreshToken === 'string' ? credentials.refreshToken : '',
        expiresAt: typeof credentials.expiresAt === 'number' ? credentials.expiresAt : 0,
        scopes: Array.isArray(credentials.scopes) ? credentials.scopes.filter(s => typeof s === 'string') : (existing.scopes || []),
        email: existing.email || undefined,
        emailAddress: existing.email || undefined,
        subscriptionType: existing.subscriptionType || undefined,
        rateLimitTier: existing.rateLimitTier || undefined
      },
      email: existing.email || undefined
    };

    const credentialsJson = JSON.stringify(newCredentialData, null, 2);

    // Ensure directory exists (matching Windows behavior)
    const dirPath = dirname(credentialsPath);
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true, mode: 0o700 });
    }

    // Write to file with secure permissions (0600)
    // lgtm[js/http-to-file-access] - credentialsPath is from controlled configDir
    writeFileSync(credentialsPath, credentialsJson, { mode: 0o600, encoding: 'utf-8' });

    if (isDebug) {
      console.warn('[CredentialUtils:Linux:Update] Successfully updated credentials file:', credentialsPath);
    }

    // Clear cached credentials to ensure fresh values are read
    clearLinuxCredentialCache(configDir);

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[CredentialUtils:Linux:Update] Failed to update credentials file:', errorMessage);
    return { success: false, error: `File update failed: ${errorMessage}` };
  }
}
