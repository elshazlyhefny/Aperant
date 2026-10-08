import { describe, it, expect } from 'vitest';
import { landsThroughPullRequestsOnly } from '../landing-policy';

// zeenha fork: PR-only landing is ON unless a project explicitly turns it off.
describe('landsThroughPullRequestsOnly', () => {
  it('is on when the setting is missing (default)', () => {
    expect(landsThroughPullRequestsOnly(undefined)).toBe(true);
    expect(landsThroughPullRequestsOnly(null)).toBe(true);
    expect(landsThroughPullRequestsOnly({})).toBe(true);
  });
  it('is on when set to true', () => {
    expect(landsThroughPullRequestsOnly({ prOnlyLanding: true })).toBe(true);
  });
  it('is off only when explicitly false', () => {
    expect(landsThroughPullRequestsOnly({ prOnlyLanding: false })).toBe(false);
  });
});
