import { beforeEach, describe, expect, it, vi } from 'vitest';

const readSettingsFile = vi.fn();
vi.mock('../../settings-utils', () => ({
  readSettingsFile: () => readSettingsFile(),
}));

import { hasAnyProviderAccount, hasUsableAuth } from './provider-account-check';

describe('provider-account-check', () => {
  beforeEach(() => {
    readSettingsFile.mockReset();
  });

  it('returns false when there is no settings file', () => {
    readSettingsFile.mockReturnValue(undefined);
    expect(hasAnyProviderAccount()).toBe(false);
  });

  it('returns false for empty providerAccounts', () => {
    readSettingsFile.mockReturnValue({ providerAccounts: [] });
    expect(hasAnyProviderAccount()).toBe(false);
  });

  it('returns true with one account', () => {
    readSettingsFile.mockReturnValue({ providerAccounts: [{ id: 'a' }] });
    expect(hasAnyProviderAccount()).toBe(true);
  });

  it('hasUsableAuth is true when the profile is valid', () => {
    readSettingsFile.mockReturnValue(undefined);
    expect(hasUsableAuth({ hasValidAuth: () => true })).toBe(true);
  });

  it('hasUsableAuth is false for invalid profile and no accounts', () => {
    readSettingsFile.mockReturnValue({ providerAccounts: [] });
    expect(hasUsableAuth({ hasValidAuth: () => false })).toBe(false);
  });

  it('hasUsableAuth is true for invalid profile with an account', () => {
    readSettingsFile.mockReturnValue({ providerAccounts: [{ id: 'a' }] });
    expect(hasUsableAuth({ hasValidAuth: () => false })).toBe(true);
  });
});
