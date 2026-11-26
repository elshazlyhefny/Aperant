/**
 * Generic OAuth Fetch Interceptor
 *
 * Data-driven OAuth token management for file-based OAuth providers.
 * Adding a new OAuth provider = adding an entry to OAUTH_PROVIDER_REGISTRY.
 *
 * Works in both main thread and worker threads since it operates
 * on a pre-resolved token file path (no Electron APIs needed).
 */

import * as fs from 'node:fs';
// @ts-expect-error - no types available for proper-lockfile
import * as lockfile from 'proper-lockfile';
import { createDebugLog, isDebugEnabled } from '../../../shared/utils/debug-logger';
import { getCodexAccountId } from '../../claude-profile/codex-usage-fetcher';
import { writeJsonAtomic } from '../../utils/atomic-file';
import { withFileLock } from '../../utils/file-lock';
import { CODEX_RESPONSES_URL, readCodexResponse } from './codex-responses';

// =============================================================================
// Debug Logging
// =============================================================================

const debugLog = createDebugLog('OAuthFetch');

// =============================================================================
// OAuth Provider Registry
// =============================================================================

interface OAuthProviderSpec {
  /** Token endpoint for refresh_token grant */
  tokenEndpoint: string;
  /** OAuth client ID */
  clientId: string;
  /** Rewrite the request URL (e.g., to a subscription-specific endpoint) */
  rewriteUrl?: (url: string) => string;
}

const OAUTH_PROVIDER_REGISTRY: Record<string, OAuthProviderSpec> = {
  openai: {
    tokenEndpoint: 'https://auth.openai.com/oauth/token',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    rewriteUrl: () => CODEX_RESPONSES_URL,
  },
  // Future OAuth providers: just add entries here
};

// =============================================================================
// Token File I/O
// =============================================================================

interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix ms
}

/** How far before expiry to consider a token "near expiry" and trigger refresh */
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

function readTokenFile(tokenFilePath: string): StoredTokens | null {
  try {
    const raw = fs.readFileSync(tokenFilePath, 'utf8');
    const tokens = JSON.parse(raw) as StoredTokens;
    debugLog('Read token file', { path: tokenFilePath, expiresAt: tokens.expires_at });
    return tokens;
  } catch {
    debugLog('Failed to read token file', { path: tokenFilePath });
    return null;
  }
}

// =============================================================================
// Token Refresh
// =============================================================================

async function refreshOAuthToken(
  refreshToken: string,
  providerSpec: OAuthProviderSpec,
  tokenFilePath: string,
): Promise<string | null> {
  debugLog('Refreshing OAuth token');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: providerSpec.clientId,
  });

  const response = await fetch(providerSpec.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });

  debugLog('Token refresh response', { status: response.status, ok: response.ok });

  if (!response.ok) {
    let errorMessage = `HTTP ${response.status}`;
    try {
      const errorData = await response.json() as Record<string, string>;
      errorMessage = errorData.error_description ?? errorData.error ?? errorMessage;
    } catch {
      // Ignore parse errors
    }
    debugLog('Token refresh failed', { error: errorMessage });
    return null;
  }

  const data = await response.json() as Record<string, unknown>;
  debugLog('Token refresh success', {
    hasAccessToken: !!data.access_token,
    hasNewRefreshToken: !!data.refresh_token,
    expiresIn: data.expires_in,
  });

  if (!data.access_token || typeof data.access_token !== 'string') {
    debugLog('Token refresh response missing access_token');
    return null;
  }

  // Token rotation: new refresh token may be issued
  const newRefreshToken =
    typeof data.refresh_token === 'string' ? data.refresh_token : refreshToken;
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;
  const expiresAt = Date.now() + expiresIn * 1000;

  // A login or logout can replace/remove the credentials while the request is in flight.
  const current = readTokenFile(tokenFilePath);
  if (current?.refresh_token !== refreshToken) return current?.access_token ?? null;
  await writeJsonAtomic(tokenFilePath, {
    access_token: data.access_token,
    refresh_token: newRefreshToken,
    expires_at: expiresAt,
  }, { mode: 0o600 });

  return data.access_token;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Detect the OAuth provider from a token file path.
 * Falls back to 'openai' (the only provider currently).
 */
function detectProvider(provider?: string): OAuthProviderSpec | undefined {
  const key = provider ?? 'openai';
  return OAUTH_PROVIDER_REGISTRY[key];
}

/**
 * Ensure a valid OAuth access token is available from the given token file.
 *
 * - Returns null if no tokens are stored.
 * - If the token expires within 5 minutes, auto-refreshes.
 * - Returns the valid access token.
 *
 * Works in both main thread and worker threads (no Electron APIs needed).
 */
export async function ensureValidOAuthToken(
  tokenFilePath: string,
  provider?: string,
): Promise<string | null> {
  debugLog('Ensuring valid OAuth token', { path: tokenFilePath, provider });

  const stored = readTokenFile(tokenFilePath);
  if (!stored) {
    debugLog('No stored tokens — returning null');
    return null;
  }

  const expiresIn = stored.expires_at - Date.now();
  debugLog('Token expiry check', { expiresInMs: expiresIn, thresholdMs: REFRESH_THRESHOLD_MS });

  if (expiresIn > REFRESH_THRESHOLD_MS) {
    debugLog('Token still valid');
    return stored.access_token;
  }

  // Token expired or near expiry — attempt refresh
  debugLog('Token expired or near expiry, attempting refresh');
  const providerSpec = detectProvider(provider);
  if (!providerSpec) {
    debugLog('No provider spec found for refresh', { provider });
    return null;
  }

  try {
    return await withFileLock(tokenFilePath, async () => {
      // Workers and the usage monitor can race to refresh a rotating OAuth token.
      const release: () => Promise<void> = await lockfile.lock(tokenFilePath, {
        retries: { retries: 20, factor: 1, minTimeout: 1_000 },
      });
      try {
        const current = readTokenFile(tokenFilePath);
        if (!current) return null;
        if (current.expires_at - Date.now() > REFRESH_THRESHOLD_MS) return current.access_token;
        return await refreshOAuthToken(current.refresh_token, providerSpec, tokenFilePath);
      } finally {
        await release();
      }
    });
  } catch (err) {
    debugLog('Token refresh failed', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Create a custom fetch function for file-based OAuth providers.
 *
 * The returned fetch interceptor:
 * 1. Reads and auto-refreshes the OAuth token from the token file
 * 2. Strips any existing Authorization header and injects the real token
 * 3. Rewrites the URL if the provider specifies a rewrite rule
 *
 * Data-driven: adding a new provider = adding an entry to OAUTH_PROVIDER_REGISTRY.
 */

export function createOAuthProviderFetch(
  tokenFilePath: string,
  provider?: string,
): typeof globalThis.fetch {
  const providerSpec = detectProvider(provider);

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // 1. Get valid OAuth token (auto-refresh if needed)
    const token = await ensureValidOAuthToken(tokenFilePath, provider);
    if (!token) {
      throw new Error('OAuth: No valid token available. Please re-authenticate.');
    }

    // 2. Build headers — strip dummy Authorization, inject real token
    const headers = new Headers(init?.headers);
    headers.delete('authorization');
    headers.delete('Authorization');
    headers.set('Authorization', `Bearer ${token}`);

    // 3. Resolve URL
    let url: string;
    if (typeof input === 'string') {
      url = input;
    } else if (input instanceof URL) {
      url = input.toString();
    } else if (input instanceof Request) {
      url = input.url;
    } else {
      url = String(input);
    }

    // 4. Rewrite URL if provider specifies a rewrite rule
    const originalUrl = url;
    if (providerSpec?.rewriteUrl) {
      url = providerSpec.rewriteUrl(url);
    }

    if (isDebugEnabled() && url !== originalUrl) {
      debugLog(`${originalUrl} -> ${url} (token: [redacted])`);
    }

    const codexRequest = url === CODEX_RESPONSES_URL && typeof init?.body === 'string'
      ? JSON.parse(init.body) as Record<string, unknown>
      : undefined;
    if (codexRequest) {
      headers.set('Accept', 'text/event-stream');
      const accountId = getCodexAccountId(token);
      if (accountId && !headers.has('ChatGPT-Account-Id')) headers.set('ChatGPT-Account-Id', accountId);
    }
    const finalInit = {
      ...init,
      headers,
      ...(codexRequest ? { body: JSON.stringify({ ...codexRequest, stream: true }), redirect: 'error' as const } : {}),
    };
    const response = await globalThis.fetch(url, finalInit);

    if (isDebugEnabled()) {
      debugLog(`Response: ${response.status} ${response.statusText}`, { url });
      if (response.status >= 400 && response.status < 500) {
        try {
          const cloned = response.clone();
          const errorBody = await cloned.text();
          debugLog('Error response body', errorBody.substring(0, 500));
        } catch {
          // Ignore clone/read errors
        }
      }
    }

    return codexRequest && codexRequest.stream !== true ? readCodexResponse(response) : response;
  };
}
