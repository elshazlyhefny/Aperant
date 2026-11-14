/**
 * Credential JSON parsing, validation and execution helpers.
 */

import { execFileSync } from 'child_process';
import type { PlatformCredentials } from './types';

/**
 * Create a safe fingerprint of a token for debug logging.
 * Shows first 8 and last 4 characters, hiding the sensitive middle portion.
 * This is NOT for authentication - only for human-readable debug identification.
 *
 * @param token - The token to create a fingerprint for
 * @returns A safe fingerprint like "sk-ant-oa...xyz9" or "null" if no token
 */
export function getTokenFingerprint(token: string | null | undefined): string {
  if (!token) return 'null';
  if (token.length <= 16) return token.slice(0, 4) + '...' + token.slice(-2);
  return token.slice(0, 8) + '...' + token.slice(-4);
}

/**
 * Validate the structure of parsed credential JSON data
 * @param data - Parsed JSON data from credential store
 * @returns true if data structure is valid, false otherwise
 */
export function validateCredentialData(data: unknown): data is { claudeAiOauth?: { accessToken?: string; email?: string; emailAddress?: string }; email?: string } {
  if (!data || typeof data !== 'object') {
    return false;
  }

  const obj = data as Record<string, unknown>;

  // Check if claudeAiOauth exists and is an object
  if (obj.claudeAiOauth !== undefined) {
    if (typeof obj.claudeAiOauth !== 'object' || obj.claudeAiOauth === null) {
      return false;
    }
    const oauth = obj.claudeAiOauth as Record<string, unknown>;
    // Validate accessToken if present
    if (oauth.accessToken !== undefined && typeof oauth.accessToken !== 'string') {
      return false;
    }
    // Validate email if present (can be 'email' or 'emailAddress')
    if (oauth.email !== undefined && typeof oauth.email !== 'string') {
      return false;
    }
    if (oauth.emailAddress !== undefined && typeof oauth.emailAddress !== 'string') {
      return false;
    }
  }

  // Validate top-level email if present
  if (obj.email !== undefined && typeof obj.email !== 'string') {
    return false;
  }

  return true;
}

/**
 * Extract token and email from validated credential data
 */
export function extractCredentials(data: { claudeAiOauth?: { accessToken?: string; email?: string; emailAddress?: string }; email?: string }): { token: string | null; email: string | null } {
  // Extract OAuth token from nested structure
  const token = data?.claudeAiOauth?.accessToken || null;

  // Extract email (might be in different locations depending on Claude Code version)
  const email = data?.claudeAiOauth?.email || data?.claudeAiOauth?.emailAddress || data?.email || null;

  return { token, email };
}

/**
 * Extract full credentials including refresh token and expiry from validated credential data
 */
export function extractFullCredentials(data: {
  claudeAiOauth?: {
    accessToken?: string;
    email?: string;
    emailAddress?: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  };
  email?: string
}): {
  token: string | null;
  email: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
  scopes: string[] | null;
  subscriptionType: string | null;
  rateLimitTier: string | null;
} {
  // Extract OAuth token from nested structure
  const token = data?.claudeAiOauth?.accessToken || null;

  // Extract email (might be in different locations depending on Claude Code version)
  const email = data?.claudeAiOauth?.email || data?.claudeAiOauth?.emailAddress || data?.email || null;

  // Extract refresh token
  const refreshToken = data?.claudeAiOauth?.refreshToken || null;

  // Extract expiry timestamp (Unix timestamp in ms)
  const expiresAt = data?.claudeAiOauth?.expiresAt || null;

  // Extract scopes (array of strings)
  const scopes = data?.claudeAiOauth?.scopes || null;

  // Extract subscription info (determines "Max" vs "API" display in Claude Code)
  const subscriptionType = data?.claudeAiOauth?.subscriptionType || null;
  const rateLimitTier = data?.claudeAiOauth?.rateLimitTier || null;

  return { token, email, refreshToken, expiresAt, scopes, subscriptionType, rateLimitTier };
}

/**
 * Execute a credential read operation with platform-specific executable.
 * Shared helper to reduce code duplication across macOS, Linux, and Windows.
 *
 * @param executablePath - Path to the security/secret-tool/powershell executable
 * @param args - Arguments to pass to the executable
 * @param timeout - Timeout in milliseconds
 * @param identifier - Identifier for logging (e.g., "macOS:serviceName", "Linux:attribute")
 * @returns The raw output string or null if not found
 */
export function executeCredentialRead(
  executablePath: string,
  args: string[],
  timeout: number,
  _identifier: string
): string | null {
  try {
    const result = execFileSync(executablePath, args, {
      encoding: 'utf-8',
      timeout,
      windowsHide: true,
    });
    return result.trim();
  } catch (error) {
    // Handle expected "not found" errors (macOS exit code 44, Linux/Windows non-zero exit)
    if (error && typeof error === 'object' && 'status' in error) {
      const status = (error as { status: number }).status;
      if (status === 44) {
        // macOS: errSecItemNotFound
        return null;
      }
    }
    // Check for "not found" in error message (Linux/Windows)
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('not found') || errorMessage.includes('exit code')) {
      return null;
    }
    // Re-throw unexpected errors
    throw error;
  }
}

/**
 * Parse and validate credential JSON from platform storage.
 * Shared helper to reduce code duplication across platforms.
 *
 * @param credentialsJson - Raw JSON string from credential store
 * @param identifier - Identifier for logging (e.g., "macOS:serviceName")
 * @param extractFn - Function to extract credentials (basic or full)
 * @returns Extracted credentials or null values if invalid
 */
export function parseCredentialJson<T extends PlatformCredentials>(
  credentialsJson: string | null,
  identifier: string,
  extractFn: (data: any) => T
): T {
  if (!credentialsJson) {
    return extractFn({}) as T;
  }

  // Parse JSON
  let data: unknown;
  try {
    data = JSON.parse(credentialsJson);
  } catch {
    console.warn(`[CredentialUtils] Failed to parse credential JSON for ${identifier}`);
    return extractFn({}) as T;
  }

  // Validate JSON structure
  if (!validateCredentialData(data)) {
    console.warn(`[CredentialUtils] Invalid credential data structure for ${identifier}`);
    return extractFn({}) as T;
  }

  return extractFn(data);
}
