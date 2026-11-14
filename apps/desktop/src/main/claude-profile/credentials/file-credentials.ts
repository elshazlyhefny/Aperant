/**
 * File-based credential reading shared by Linux and Windows storage.
 */

import { existsSync, readFileSync } from 'fs';
import { CACHE_TTL_MS, ERROR_CACHE_TTL_MS, credentialCache } from './cache';
import { isValidCredentialsPath, isValidTokenFormat } from './naming';
import {
  extractCredentials,
  extractFullCredentials,
  getTokenFingerprint,
  validateCredentialData,
} from './parsing';
import { isVerbose } from './types';
import type { FullOAuthCredentials, PlatformCredentials } from './types';

/**
 * Shared implementation for reading credentials from a JSON file.
 * Used by both Linux and Windows file-based credential storage.
 *
 * @param credentialsPath - Path to the credentials file
 * @param cacheKey - Cache key for storing results
 * @param logPrefix - Prefix for log messages (e.g., "Linux", "Windows:File")
 * @param forceRefresh - Whether to bypass cache
 * @returns Platform credentials with token and email
 */
export function getCredentialsFromFile(
  credentialsPath: string,
  cacheKey: string,
  logPrefix: string,
  forceRefresh = false
): PlatformCredentials {
  const isDebug = process.env.DEBUG === 'true';
  const now = Date.now();

  // Return cached credentials if available and fresh
  const cached = credentialCache.get(cacheKey);
  if (!forceRefresh && cached) {
    const ttl = cached.credentials.error ? ERROR_CACHE_TTL_MS : CACHE_TTL_MS;
    if ((now - cached.timestamp) < ttl) {
      if (isVerbose) {
        const cacheAge = now - cached.timestamp;
        console.warn(`[CredentialUtils:${logPrefix}:CACHE] Returning cached credentials:`, {
          credentialsPath,
          hasToken: !!cached.credentials.token,
          tokenFingerprint: getTokenFingerprint(cached.credentials.token),
          cacheAge: Math.round(cacheAge / 1000) + 's'
        });
      }
      return cached.credentials;
    }
  }

  // Defense-in-depth: Validate credentials path is within expected boundaries
  if (!isValidCredentialsPath(credentialsPath)) {
    if (isDebug) {
      console.warn(`[CredentialUtils:${logPrefix}] Invalid credentials path rejected:`, { credentialsPath });
    }
    const invalidResult = { token: null, email: null, error: 'Invalid credentials path' };
    credentialCache.set(cacheKey, { credentials: invalidResult, timestamp: now });
    return invalidResult;
  }

  // Check if credentials file exists
  if (!existsSync(credentialsPath)) {
    if (isDebug) {
      console.warn(`[CredentialUtils:${logPrefix}] Credentials file not found:`, credentialsPath);
    }
    const notFoundResult = { token: null, email: null };
    credentialCache.set(cacheKey, { credentials: notFoundResult, timestamp: now });
    return notFoundResult;
  }

  try {
    const content = readFileSync(credentialsPath, 'utf-8');

    // Parse JSON
    let data: unknown;
    try {
      data = JSON.parse(content);
    } catch {
      console.warn(`[CredentialUtils:${logPrefix}] Failed to parse credentials JSON:`, credentialsPath);
      const errorResult = { token: null, email: null };
      credentialCache.set(cacheKey, { credentials: errorResult, timestamp: now });
      return errorResult;
    }

    // Validate JSON structure
    if (!validateCredentialData(data)) {
      console.warn(`[CredentialUtils:${logPrefix}] Invalid credentials data structure:`, credentialsPath);
      const invalidResult = { token: null, email: null };
      credentialCache.set(cacheKey, { credentials: invalidResult, timestamp: now });
      return invalidResult;
    }

    const { token, email } = extractCredentials(data);

    // Validate token format if present
    if (token && !isValidTokenFormat(token)) {
      console.warn(`[CredentialUtils:${logPrefix}] Invalid token format in:`, credentialsPath);
      const result = { token: null, email };
      credentialCache.set(cacheKey, { credentials: result, timestamp: now });
      return result;
    }

    const credentials = { token, email };
    credentialCache.set(cacheKey, { credentials, timestamp: now });

    if (isVerbose) {
      console.warn(`[CredentialUtils:${logPrefix}] Retrieved credentials from file:`, credentialsPath, {
        hasToken: !!token,
        hasEmail: !!email,
        tokenFingerprint: getTokenFingerprint(token),
        forceRefresh
      });
    }
    return credentials;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn(`[CredentialUtils:${logPrefix}] Failed to read credentials file:`, credentialsPath, errorMessage);
    const errorResult = { token: null, email: null, error: `Failed to read credentials: ${errorMessage}` };
    credentialCache.set(cacheKey, { credentials: errorResult, timestamp: now });
    return errorResult;
  }
}

/**
 * Shared implementation for reading full credentials from a JSON file.
 * Used by both Linux and Windows file-based credential storage.
 *
 * @param credentialsPath - Path to the credentials file
 * @param logPrefix - Prefix for log messages (e.g., "Linux:Full", "Windows:File:Full")
 * @returns Full OAuth credentials including refresh token
 */
export function getFullCredentialsFromFile(
  credentialsPath: string,
  logPrefix: string
): FullOAuthCredentials {
  const isDebug = process.env.DEBUG === 'true';

  // Defense-in-depth: Validate credentials path is within expected boundaries
  if (!isValidCredentialsPath(credentialsPath)) {
    if (isDebug) {
      console.warn(`[CredentialUtils:${logPrefix}] Invalid credentials path rejected:`, { credentialsPath });
    }
    return { token: null, email: null, refreshToken: null, expiresAt: null, scopes: null, subscriptionType: null, rateLimitTier: null, error: 'Invalid credentials path' };
  }

  // Check if credentials file exists
  if (!existsSync(credentialsPath)) {
    if (isDebug) {
      console.warn(`[CredentialUtils:${logPrefix}] Credentials file not found:`, credentialsPath);
    }
    return { token: null, email: null, refreshToken: null, expiresAt: null, scopes: null, subscriptionType: null, rateLimitTier: null };
  }

  try {
    const content = readFileSync(credentialsPath, 'utf-8');

    // Parse JSON
    let data: unknown;
    try {
      data = JSON.parse(content);
    } catch {
      console.warn(`[CredentialUtils:${logPrefix}] Failed to parse credentials JSON:`, credentialsPath);
      return { token: null, email: null, refreshToken: null, expiresAt: null, scopes: null, subscriptionType: null, rateLimitTier: null };
    }

    // Validate JSON structure
    if (!validateCredentialData(data)) {
      console.warn(`[CredentialUtils:${logPrefix}] Invalid credentials data structure:`, credentialsPath);
      return { token: null, email: null, refreshToken: null, expiresAt: null, scopes: null, subscriptionType: null, rateLimitTier: null };
    }

    const { token, email, refreshToken, expiresAt, scopes, subscriptionType, rateLimitTier } = extractFullCredentials(data);

    // Validate token format if present
    if (token && !isValidTokenFormat(token)) {
      console.warn(`[CredentialUtils:${logPrefix}] Invalid token format in:`, credentialsPath);
      return { token: null, email, refreshToken, expiresAt, scopes, subscriptionType, rateLimitTier };
    }

    if (isVerbose) {
      console.warn(`[CredentialUtils:${logPrefix}] Retrieved full credentials from file:`, credentialsPath, {
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
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn(`[CredentialUtils:${logPrefix}] Failed to read credentials file:`, credentialsPath, errorMessage);
    return { token: null, email: null, refreshToken: null, expiresAt: null, scopes: null, subscriptionType: null, rateLimitTier: null, error: `Failed to read credentials: ${errorMessage}` };
  }
}
