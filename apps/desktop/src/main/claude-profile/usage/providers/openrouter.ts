/**
 * OpenRouter usage adapter (GET /api/v1/key).
 *
 * OpenRouter bills by spend, so the snapshot carries `creditUsage` (USD) and a
 * percentage only when the key has a spend cap.
 */

import type { ClaudeUsageSnapshot } from '../../../../shared/types/agent';
import type { UsageProviderAdapter } from '../types';

const CREDIT_WINDOW_LABEL = 'common:usage.windowCredit';

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isResetPeriod(value: unknown): value is 'daily' | 'weekly' | 'monthly' {
  return value === 'daily' || value === 'weekly' || value === 'monthly';
}

/**
 * Normalize the (already unwrapped) OpenRouter key response.
 * Returns null when the payload has no usable `usage` number.
 */
export function normalizeOpenRouterKeyResponse(
  data: unknown,
  profileId: string,
  profileName: string,
  profileEmail?: string
): ClaudeUsageSnapshot | null {
  if (!data || typeof data !== 'object') {
    console.warn('[UsageMonitor:OPENROUTER] Invalid key response: not an object');
    return null;
  }

  const record = data as Record<string, unknown>;
  const usage = record.usage;
  if (!isFiniteNumber(usage)) {
    console.warn('[UsageMonitor:OPENROUTER] Invalid key response: missing or non-numeric usage');
    return null;
  }

  const limit = isFiniteNumber(record.limit) && record.limit > 0 ? record.limit : null;

  let percent = 0;
  let remaining: number | null = null;
  if (limit !== null) {
    percent = Math.min(100, Math.max(0, Math.round((usage / limit) * 100)));
    remaining = isFiniteNumber(record.limit_remaining)
      ? record.limit_remaining
      : Math.max(limit - usage, 0);
  }

  const snapshot: ClaudeUsageSnapshot = {
    sessionPercent: percent,
    weeklyPercent: percent,
    limitType: 'session',
    fetchedAt: new Date(),
    profileId,
    profileName,
    profileEmail,
    creditUsage: {
      used: usage,
      limit,
      remaining,
      resetPeriod: isResetPeriod(record.limit_reset) ? record.limit_reset : null
    },
    usageWindows: {
      sessionWindowLabel: CREDIT_WINDOW_LABEL,
      weeklyWindowLabel: CREDIT_WINDOW_LABEL
    }
  };

  if (limit !== null) {
    snapshot.sessionUsageValue = usage;
    snapshot.sessionUsageLimit = limit;
  }

  return snapshot;
}

export const openrouterAdapter: UsageProviderAdapter = {
  provider: 'openrouter',
  usagePath: '/api/v1/key',
  allowedDomains: ['openrouter.ai'],
  buildHeaders() {
    // Authorization: Bearer is added by fetchProviderUsage
    return {};
  },
  extractData(raw) {
    return raw.data ?? raw;
  },
  normalize(data, ids) {
    return normalizeOpenRouterKeyResponse(data, ids.profileId, ids.profileName, ids.profileEmail);
  }
};
