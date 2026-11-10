/**
 * Shared quota/limit normalization for z.ai and ZHIPU providers.
 */

import type { ClaudeUsageSnapshot } from '../../../../shared/types/agent';

/**
 * Normalize quota/limit response for z.ai and ZHIPU providers
 *
 * Both providers use the same response format with a limits array containing
 * TOKENS_LIMIT (5-hour usage) and TIME_LIMIT (monthly usage) items.
 *
 * @param data - Raw response data with limits array
 * @param profileId - Profile identifier
 * @param profileName - Profile display name
 * @param profileEmail - Optional email associated with the profile
 * @param providerName - Provider name for logging ('zai' or 'zhipu')
 * @returns Normalized usage snapshot or null on parse failure
 */
export function normalizeQuotaLimitResponse(
  // biome-ignore lint/suspicious/noExplicitAny: provider responses are untyped JSON
  data: any,
  profileId: string,
  profileName: string,
  profileEmail: string | undefined,
  providerName: 'zai' | 'zhipu',
  isVerbose = false
): ClaudeUsageSnapshot | null {
  const logPrefix = providerName.toUpperCase();

  if (isVerbose) {
    console.warn(`[UsageMonitor:${logPrefix}_NORMALIZATION] Starting normalization:`, {
      profileId,
      profileName,
      responseKeys: Object.keys(data),
      hasLimits: !!data.limits,
      limitsCount: data.limits?.length || 0
    });
  }

  try {
    // Check if response has limits array
    if (!data || !Array.isArray(data.limits)) {
      console.warn(`[UsageMonitor:${logPrefix}] Invalid response format - missing limits array:`, {
        hasData: !!data,
        hasLimits: !!data?.limits,
        limitsType: typeof data?.limits
      });
      return null;
    }

    // Find TOKENS_LIMIT (5-hour usage) and TIME_LIMIT (monthly usage)
    const tokensLimit = data.limits.find((item: any) => item.type === 'TOKENS_LIMIT');
    const timeLimit = data.limits.find((item: any) => item.type === 'TIME_LIMIT');

    if (isVerbose) {
      console.warn(`[UsageMonitor:${logPrefix}_NORMALIZATION] Found limit types:`, {
        hasTokensLimit: !!tokensLimit,
        hasTimeLimit: !!timeLimit,
        tokensLimit: tokensLimit ? {
          type: tokensLimit.type,
          unit: tokensLimit.unit,
          number: tokensLimit.number,
          usage: tokensLimit.usage,
          currentValue: tokensLimit.currentValue,
          remaining: tokensLimit.remaining,
          percentage: tokensLimit.percentage,
          nextResetTime: tokensLimit.nextResetTime,
          nextResetDate: tokensLimit.nextResetTime ? new Date(tokensLimit.nextResetTime).toISOString() : undefined
        } : null,
        timeLimit: timeLimit ? {
          type: timeLimit.type,
          percentage: timeLimit.percentage,
          currentValue: timeLimit.currentValue,
          remaining: timeLimit.remaining
        } : null
      });
    }

    // Extract percentages
    const sessionPercent = tokensLimit?.percentage !== undefined
      ? Math.round(tokensLimit.percentage)
      : 0;

    const weeklyPercent = timeLimit?.percentage !== undefined
      ? Math.round(timeLimit.percentage)
      : 0;

    if (isVerbose) {
      console.warn(`[UsageMonitor:${logPrefix}_NORMALIZATION] Extracted usage:`, {
        sessionPercent,
        weeklyPercent,
        limitType: weeklyPercent > sessionPercent ? 'weekly' : 'session'
      });
    }

    // Extract reset time from API response
    // The API provides nextResetTime as a Unix timestamp (milliseconds) for TOKENS_LIMIT
    const now = new Date();
    let sessionResetTimestamp: string;

    if (tokensLimit?.nextResetTime && typeof tokensLimit.nextResetTime === 'number') {
      // Use the reset time from the API response (Unix timestamp in ms)
      sessionResetTimestamp = new Date(tokensLimit.nextResetTime).toISOString();
    } else {
      // Fallback: calculate as 5 hours from now
      sessionResetTimestamp = new Date(now.getTime() + 5 * 60 * 60 * 1000).toISOString();
    }

    // Calculate monthly reset time (1st of next month at midnight UTC)
    const nextMonth = new Date(now);
    nextMonth.setUTCMonth(now.getUTCMonth() + 1, 1);
    nextMonth.setUTCHours(0, 0, 0, 0);
    const weeklyResetTimestamp = nextMonth.toISOString();

    return {
      sessionPercent,
      weeklyPercent,
      // Omit sessionResetTime/weeklyResetTime - renderer uses timestamps with formatTimeRemaining
      sessionResetTime: undefined,
      weeklyResetTime: undefined,
      sessionResetTimestamp,
      weeklyResetTimestamp,
      profileId,
      profileName,
      profileEmail,
      fetchedAt: new Date(),
      limitType: weeklyPercent > sessionPercent ? 'weekly' : 'session',
      usageWindows: {
        sessionWindowLabel: 'common:usage.window5HoursQuota',
        weeklyWindowLabel: 'common:usage.windowMonthlyToolsQuota'
      },
      // Extract raw usage values for display in tooltip
      sessionUsageValue: tokensLimit?.currentValue,
      sessionUsageLimit: tokensLimit?.usage,
      weeklyUsageValue: timeLimit?.currentValue,
      weeklyUsageLimit: timeLimit?.usage
    };
  } catch (error) {
    console.error(`[UsageMonitor:${logPrefix}] Failed to parse quota/limit response:`, error, 'Raw data:', data);
    return null;
  }
}
