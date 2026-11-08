import { describe, expect, it } from 'vitest';
import { formatDuration, formatTokens } from '../usage-format';

describe('formatDuration', () => {
  it('formats milliseconds, seconds, minutes and hours', () => {
    expect(formatDuration(850)).toBe('850ms');
    expect(formatDuration(5000)).toBe('5s');
    expect(formatDuration(184000)).toBe('3m 4s');
    expect(formatDuration(3720000)).toBe('1h 2m');
  });
  it('handles zero and invalid input', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(Number.NaN)).toBe('0ms');
  });
});

describe('formatTokens', () => {
  it('groups digits per locale', () => {
    expect(formatTokens(1234567, 'en')).toBe('1,234,567');
    expect(formatTokens(999, 'en')).toBe('999');
  });
});
