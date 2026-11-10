import { describe, expect, it } from 'vitest';
import { calculateAvailabilityScore } from './availability-score';

describe('calculateAvailabilityScore', () => {
  it('returns 100 for an idle, authenticated profile', () => {
    expect(calculateAvailabilityScore(0, 0, false)).toBe(100);
  });

  it('subtracts weighted usage', () => {
    // 100 - 40*0.5 - 50*0.2 = 70
    expect(calculateAvailabilityScore(50, 40, false)).toBe(70);
  });

  it('applies a session rate-limit penalty', () => {
    expect(calculateAvailabilityScore(0, 0, true, 'session')).toBe(-400);
    expect(calculateAvailabilityScore(0, 0, true)).toBe(-400);
  });

  it('applies a weekly rate-limit penalty', () => {
    expect(calculateAvailabilityScore(0, 0, true, 'weekly')).toBe(-900);
  });

  it('ignores rateLimitType when not rate limited', () => {
    expect(calculateAvailabilityScore(0, 0, false, 'weekly')).toBe(100);
  });

  it('applies an unauthenticated penalty', () => {
    expect(calculateAvailabilityScore(0, 0, false, undefined, false)).toBe(-400);
  });

  it('rounds to 2 decimal places', () => {
    // 100 - 33.33*0.5 - 11.11*0.2 = 81.1115 -> 81.11
    expect(calculateAvailabilityScore(11.11, 33.33, false)).toBe(81.11);
  });
});
