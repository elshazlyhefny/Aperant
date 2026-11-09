import { describe, it, expect } from 'vitest';
import { getKeyStatus, withKeyStatus, withKeyStatusReset, failoverTier } from '../api-key-status';
import { apiProfileToUnified } from '../unified-account';
import type { APIProfile } from '../../types/profile';

const profile: APIProfile = {
  id: 'p1', name: 'P', baseUrl: 'https://x', apiKey: 'k', createdAt: 1, updatedAt: 1,
};

describe('api-key-status', () => {
  it('defaults to unverified', () => {
    expect(getKeyStatus({})).toBe('unverified');
    expect(getKeyStatus({ keyStatus: 'valid' })).toBe('valid');
  });

  it('withKeyStatus returns a copy with status and timestamp', () => {
    const out = withKeyStatus(profile, 'rejected', 42);
    expect(out).not.toBe(profile);
    expect(out.keyStatus).toBe('rejected');
    expect(out.keyStatusAt).toBe(42);
    expect(profile.keyStatus).toBeUndefined();
  });

  it('withKeyStatusReset removes both fields', () => {
    const out = withKeyStatusReset(withKeyStatus(profile, 'valid', 1));
    expect('keyStatus' in out).toBe(false);
    expect('keyStatusAt' in out).toBe(false);
  });

  it('failoverTier ranks valid before unverified', () => {
    expect(failoverTier('valid')).toBe(0);
    expect(failoverTier('unverified')).toBe(1);
  });

  it('apiProfileToUnified marks rejected keys unavailable', () => {
    expect(apiProfileToUnified(profile, false, true, 'rejected').isAvailable).toBe(false);
    expect(apiProfileToUnified(profile, false, true, 'valid').isAvailable).toBe(true);
    expect(apiProfileToUnified(profile, false, true).keyStatus).toBe('unverified');
  });
});
