/**
 * Anthropic OAuth usage adapter.
 */

import type { ClaudeUsageSnapshot } from '../../../../shared/types/agent';
import type { UsageProviderAdapter } from '../types';

/**
 * Normalize Anthropic API response to ClaudeUsageSnapshot
 *
 * Actual Anthropic OAuth usage API response format:
 * {
 *   "five_hour": {
 *     "utilization": 19,  // integer 0-100
 *     "resets_at": "2025-01-17T15:00:00Z"
 *   },
 *   "seven_day": {
 *     "utilization": 45,  // integer 0-100
 *     "resets_at": "2025-01-20T12:00:00Z"
 *   }
 * }
 */
export function normalizeAnthropicResponse(
  // biome-ignore lint/suspicious/noExplicitAny: provider responses are untyped JSON
  data: any,
  profileId: string,
  profileName: string,
  profileEmail?: string
): ClaudeUsageSnapshot {
  // Support both new nested format and legacy flat format for backward compatibility
  //
  // NEW format (current API): { five_hour: { utilization: 72, resets_at: "..." } }
  // OLD format (legacy):      { five_hour_utilization: 0.72, five_hour_reset_at: "..." }

  let fiveHourUtil: number;
  let sevenDayUtil: number;
  let sessionResetTimestamp: string | undefined;
  let weeklyResetTimestamp: string | undefined;

  // Check for new nested format first
  if (data.five_hour !== undefined || data.seven_day !== undefined) {
    // New nested format - utilization is already 0-100 integer
    fiveHourUtil = data.five_hour?.utilization ?? 0;
    sevenDayUtil = data.seven_day?.utilization ?? 0;
    sessionResetTimestamp = data.five_hour?.resets_at;
    weeklyResetTimestamp = data.seven_day?.resets_at;
  } else {
    // Legacy flat format - utilization is 0-1 float, needs *100
    const rawFiveHour = data.five_hour_utilization ?? 0;
    const rawSevenDay = data.seven_day_utilization ?? 0;
    // Convert 0-1 float to 0-100 integer
    fiveHourUtil = Math.round(rawFiveHour * 100);
    sevenDayUtil = Math.round(rawSevenDay * 100);
    sessionResetTimestamp = data.five_hour_reset_at;
    weeklyResetTimestamp = data.seven_day_reset_at;
  }

  return {
    sessionPercent: fiveHourUtil,
    weeklyPercent: sevenDayUtil,
    // Omit sessionResetTime/weeklyResetTime - renderer uses timestamps with formatTimeRemaining
    sessionResetTime: undefined,
    weeklyResetTime: undefined,
    sessionResetTimestamp,
    weeklyResetTimestamp,
    profileId,
    profileName,
    profileEmail,
    fetchedAt: new Date(),
    limitType: sevenDayUtil > fiveHourUtil ? 'weekly' : 'session',
    usageWindows: {
      sessionWindowLabel: 'common:usage.window5Hour',
      weeklyWindowLabel: 'common:usage.window7Day'
    }
  };
}

export const anthropicAdapter: UsageProviderAdapter = {
  provider: 'anthropic',
  usagePath: '/api/oauth/usage',
  allowedDomains: ['api.anthropic.com'],
  buildHeaders() {
    // OAuth authentication requires the beta header
    // See: https://codelynx.dev/posts/claude-code-usage-limits-statusline
    return {
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
      'anthropic-version': '2023-06-01'
    };
  },
  extractData(raw) {
    return raw;
  },
  normalize(_data, ids, raw) {
    // Anthropic normalizes the raw response (no data envelope)
    return normalizeAnthropicResponse(raw, ids.profileId, ids.profileName, ids.profileEmail);
  }
};
