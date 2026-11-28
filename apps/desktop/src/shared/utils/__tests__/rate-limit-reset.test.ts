import { describe, expect, it } from 'vitest';
import { extractRateLimitResetAt, isRateLimitReason } from '../rate-limit-reset';

// Local time, like the parser
const NOW = new Date(2026, 10, 28, 10, 0, 0).getTime();

describe('extractRateLimitResetAt', () => {
  it('reads the epoch suffix of a Claude usage limit', () => {
    const seconds = Math.floor(NOW / 1000) + 7200;
    expect(extractRateLimitResetAt(`Claude AI usage limit reached|${seconds}`, NOW)).toBe(seconds * 1000);
  });

  it('reads relative waits', () => {
    expect(extractRateLimitResetAt('429: please retry after 30 seconds', NOW)).toBe(NOW + 30_000);
    expect(extractRateLimitResetAt('Rate limit exceeded, try again in 5 minutes', NOW)).toBe(NOW + 300_000);
    expect(extractRateLimitResetAt('retry-after: 12', NOW)).toBe(NOW + 12_000);
  });

  it('reads a reset clock time later today, or tomorrow when it has passed', () => {
    expect(extractRateLimitResetAt("You've hit your limit · resets 3pm (Europe/Oslo)", NOW))
      .toBe(new Date(2026, 10, 28, 15, 0).getTime());
    expect(extractRateLimitResetAt('5-hour limit reached ∙ resets 9:30am', NOW))
      .toBe(new Date(2026, 10, 29, 9, 30).getTime());
  });

  it('reads a reset date', () => {
    expect(extractRateLimitResetAt('Limit reached · resets Dec 1 at 6am (Europe/Oslo)', NOW))
      .toBe(new Date(2026, 11, 1, 6, 0).getTime());
  });

  it('returns null when no reset is named, or it is in the past or too far away', () => {
    expect(extractRateLimitResetAt('429 Too Many Requests', NOW)).toBeNull();
    expect(extractRateLimitResetAt(undefined, NOW)).toBeNull();
    expect(extractRateLimitResetAt(`limit reached|${Math.floor(NOW / 1000) - 10}`, NOW)).toBeNull();
    expect(extractRateLimitResetAt('resets Mar 1 at 6am', NOW)).toBeNull();
  });
});

describe('isRateLimitReason', () => {
  it('recognises rate and usage limits only', () => {
    expect(isRateLimitReason('Rate limit exceeded: 429')).toBe(true);
    expect(isRateLimitReason("You've hit your usage limit")).toBe(true);
    expect(isRateLimitReason('Build failed: tests did not pass')).toBe(false);
    expect(isRateLimitReason(undefined)).toBe(false);
  });
});
