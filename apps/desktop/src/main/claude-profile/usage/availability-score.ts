/**
 * Calculate availability score for a profile (higher = more available)
 *
 * Scoring algorithm:
 * - Base score: 100
 * - Rate limited: -500 (session) or -1000 (weekly)
 * - Unauthenticated: -500
 * - Weekly usage penalty: -(weeklyPercent * 0.5)
 * - Session usage penalty: -(sessionPercent * 0.2)
 */
export function calculateAvailabilityScore(
  sessionPercent: number,
  weeklyPercent: number,
  isRateLimited: boolean,
  rateLimitType?: 'session' | 'weekly',
  isAuthenticated: boolean = true
): number {
  let score = 100;

  // Penalize rate-limited profiles heavily
  if (isRateLimited) {
    if (rateLimitType === 'weekly') {
      score -= 1000; // Weekly limit is worse (takes longer to reset)
    } else {
      score -= 500; // Session limit resets sooner
    }
  }

  // Penalize unauthenticated profiles
  if (!isAuthenticated) {
    score -= 500;
  }

  // Penalize based on current usage (weekly more important)
  score -= weeklyPercent * 0.5;
  score -= sessionPercent * 0.2;

  return Math.round(score * 100) / 100; // Round to 2 decimal places
}
