/**
 * Generic provider usage HTTP client.
 *
 * Performs the request, response classification and normalization for any
 * registered provider adapter. Holds no scheduling or failover state: the
 * caller translates the returned outcome into cooldowns and rate-limit marks.
 */

import type { ApiProvider } from '../../../shared/utils/provider-detection';
import { getUsageEndpoint } from './endpoints';
import { getAllowedUsageDomains, getUsageProviderAdapter } from './providers/registry';
import type { ProviderUsageOutcome } from './types';
import { getCredentialFingerprint } from './usage-log';
import type { UsageLogger } from './usage-log';

const ALLOWED_USAGE_API_DOMAINS = getAllowedUsageDomains();

// Common auth error patterns in provider error response bodies
const AUTH_ERROR_PATTERNS = [
  'unauthorized',
  'authentication',
  'invalid token',
  'invalid api key',
  'expired token',
  'forbidden',
  'access denied',
  'credentials',
  'auth failed'
];

export interface FetchProviderUsageParams {
  credential: string;
  provider: ApiProvider;
  baseUrl: string;
  profileId: string;
  profileName: string;
  profileEmail?: string;
  log: UsageLogger;
}

/**
 * Fetch and normalize usage for a provider.
 *
 * Auth failures (401/403 or detected in the error body) are thrown as errors
 * carrying `statusCode`. Network and parse errors also propagate as throws.
 */
export async function fetchProviderUsage(params: FetchProviderUsageParams): Promise<ProviderUsageOutcome> {
  const { credential, provider, baseUrl, profileId, profileName, profileEmail, log } = params;
  const { debugLog, traceLog } = log;

  const usageEndpoint = getUsageEndpoint(provider, baseUrl);
  const adapter = getUsageProviderAdapter(provider);
  if (!usageEndpoint || !adapter) {
    debugLog('[UsageMonitor] Unknown provider - no usage endpoint configured:', {
      provider,
      baseUrl,
      profileId
    });
    return { kind: 'unsupported' };
  }

  traceLog('[UsageMonitor:API_FETCH] API request:', {
    endpoint: usageEndpoint,
    profileId,
    credentialFingerprint: getCredentialFingerprint(credential)
  });

  traceLog('[UsageMonitor:API_FETCH] Fetching from endpoint:', {
    provider,
    endpoint: usageEndpoint,
    hasCredential: !!credential
  });

  // Security: Only allow requests to known provider domains
  let endpointHostname: string;
  try {
    endpointHostname = new URL(usageEndpoint).hostname;
  } catch {
    console.error('[UsageMonitor] Invalid usage endpoint URL:', usageEndpoint);
    return { kind: 'failed', cooldown: false };
  }

  if (!ALLOWED_USAGE_API_DOMAINS.has(endpointHostname)) {
    console.error('[UsageMonitor] Blocked request to unauthorized domain:', endpointHostname, {
      allowedDomains: Array.from(ALLOWED_USAGE_API_DOMAINS)
    });
    return { kind: 'failed', cooldown: false };
  }

  // All providers use Bearer token authentication (RFC 6750)
  // CodeQL: validate credential is a non-empty string before use
  const safeCredential = typeof credential === 'string' && credential.length > 0 ? credential : '';
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${safeCredential}`,
    'Content-Type': 'application/json',
    ...(await adapter.buildHeaders(credential))
  };

  const response = await fetch(usageEndpoint, {
    method: 'GET',
    headers
  });

  if (!response.ok) {
    console.error('[UsageMonitor] API error:', response.status, response.statusText, {
      provider,
      endpoint: usageEndpoint
    });

    if (response.status === 429) {
      return { kind: 'rate-limited' };
    }

    // Auth failures via status code (works for all providers)
    if (response.status === 401 || response.status === 403) {
      const error = new Error(`API Auth Failure: ${response.status} (${provider})`);
      (error as any).statusCode = response.status;
      throw error;
    }

    // For other error statuses, parse the body to detect auth failures
    let errorData: any;
    try {
      errorData = await response.json();
    } catch (parseError) {
      traceLog('[UsageMonitor:AUTH_DETECTION] Could not parse error response body:', {
        provider,
        status: response.status,
        parseError
      });
      return { kind: 'failed', cooldown: true };
    }

    traceLog('[UsageMonitor:AUTH_DETECTION] Checking error response for auth failure:', {
      provider,
      status: response.status,
      errorData
    });

    const errorText = JSON.stringify(errorData).toLowerCase();
    const hasAuthError = AUTH_ERROR_PATTERNS.some(pattern => errorText.includes(pattern));

    if (hasAuthError) {
      const error = new Error(`API Auth Failure detected in response body (${provider}): ${JSON.stringify(errorData)}`);
      (error as any).statusCode = response.status; // Include original status code
      (error as any).detectedInBody = true;
      throw error;
    }

    return { kind: 'failed', cooldown: true };
  }

  traceLog('[UsageMonitor:API_FETCH] API response received successfully:', {
    provider,
    status: response.status,
    contentType: response.headers.get('content-type')
  });

  const rawData = await response.json();

  traceLog('[UsageMonitor:PROVIDER] Raw response from ' + provider + ':', JSON.stringify(rawData, null, 2));

  const responseData = adapter.extractData(rawData);

  traceLog('[UsageMonitor:NORMALIZATION] Selecting normalization method:', {
    provider,
    method: `normalize${provider.charAt(0).toUpperCase() + provider.slice(1)}Response`
  });

  const normalizedUsage = adapter.normalize(responseData, { profileId, profileName, profileEmail }, rawData);

  if (!normalizedUsage) {
    traceLog('[UsageMonitor:TRACE] Failed to normalize response from ' + provider);
    return { kind: 'failed', cooldown: true };
  }

  traceLog('[UsageMonitor:API_FETCH] Fetch completed - usage:', {
    profileId,
    profileName,
    email: normalizedUsage.profileEmail,
    provider,
    sessionPercent: normalizedUsage.sessionPercent,
    weeklyPercent: normalizedUsage.weeklyPercent,
    limitType: normalizedUsage.limitType
  });
  traceLog('[UsageMonitor:API_FETCH] API fetch completed successfully');

  return { kind: 'ok', usage: normalizedUsage };
}
