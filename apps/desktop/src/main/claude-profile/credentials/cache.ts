/**
 * Shared credential cache (single Map instance used by all platform modules).
 */

import type { PlatformCredentials } from './types';

/**
 * Cache for credentials to avoid repeated blocking calls
 * Map key is the cache key (e.g., "macos:Claude Code-credentials" or "linux:/home/user/.claude")
 */
export interface CredentialCacheEntry {
  credentials: PlatformCredentials;
  timestamp: number;
}

export const credentialCache = new Map<string, CredentialCacheEntry>();
// Cache for 5 minutes (300,000 ms) for successful results
export const CACHE_TTL_MS = 5 * 60 * 1000;
// Cache for 10 seconds for error results (allows quick retry after unlock)
export const ERROR_CACHE_TTL_MS = 10 * 1000;
