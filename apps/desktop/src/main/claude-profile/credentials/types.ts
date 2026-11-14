/**
 * Shared credential types and constants.
 */

/**
 * Credentials retrieved from platform-specific secure storage
 */
export interface PlatformCredentials {
  token: string | null;
  email: string | null;
  error?: string;  // Set when credential access fails (locked, permission denied, etc.)
}

// Legacy alias for backwards compatibility
export type KeychainCredentials = PlatformCredentials;

/**
 * Full OAuth credentials including refresh token and expiry info
 * Used for token refresh operations
 */
export interface FullOAuthCredentials extends PlatformCredentials {
  refreshToken: string | null;
  expiresAt: number | null;  // Unix timestamp in ms when access token expires
  scopes: string[] | null;
  subscriptionType: string | null;  // e.g., "max" for Claude Max subscription
  rateLimitTier: string | null;     // e.g., "default_claude_max_20x"
}

/**
 * Result of updating credentials in the keychain/credential store
 */
export interface UpdateCredentialsResult {
  success: boolean;
  error?: string;
}

export const isVerbose = process.env.VERBOSE === 'true';

// Timeouts for credential retrieval operations
export const MACOS_KEYCHAIN_TIMEOUT_MS = 5000;
export const WINDOWS_CREDMAN_TIMEOUT_MS = 10000;
export const LINUX_SECRET_TOOL_TIMEOUT_MS = 5000;
