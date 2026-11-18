import { describe, expect, it } from 'vitest';
import { normalizeIssueWritebackSettings } from '../issue-writeback-settings';

const DEFAULTS = {
  github: false,
  gitlab: false,
  linear: false,
  linearTransitionOnReview: false,
  linearTransitionStateName: 'In Review'
};

describe('normalizeIssueWritebackSettings', () => {
  it('returns defaults for undefined and garbage input', () => {
    expect(normalizeIssueWritebackSettings(undefined)).toEqual(DEFAULTS);
    expect(normalizeIssueWritebackSettings(null)).toEqual(DEFAULTS);
    expect(normalizeIssueWritebackSettings('nope')).toEqual(DEFAULTS);
    expect(normalizeIssueWritebackSettings(42)).toEqual(DEFAULTS);
  });

  it('treats non-boolean truthy values as false', () => {
    const result = normalizeIssueWritebackSettings({
      github: 1,
      gitlab: 'true',
      linear: {},
      linearTransitionOnReview: 'yes'
    });
    expect(result).toEqual(DEFAULTS);
  });

  it('keeps true booleans', () => {
    const result = normalizeIssueWritebackSettings({
      github: true,
      gitlab: true,
      linear: true,
      linearTransitionOnReview: true,
      linearTransitionStateName: 'Done'
    });
    expect(result).toEqual({
      github: true,
      gitlab: true,
      linear: true,
      linearTransitionOnReview: true,
      linearTransitionStateName: 'Done'
    });
  });

  it('strips control characters from the state name', () => {
    const result = normalizeIssueWritebackSettings({ linearTransitionStateName: 'In\n Re\u0000view\u007f' });
    expect(result.linearTransitionStateName).toBe('In Review');
  });

  it('caps an over-long state name at 100 characters', () => {
    const result = normalizeIssueWritebackSettings({ linearTransitionStateName: 'a'.repeat(150) });
    expect(result.linearTransitionStateName).toBe('a'.repeat(100));
  });

  it('falls back to the default for whitespace-only or non-string names', () => {
    expect(normalizeIssueWritebackSettings({ linearTransitionStateName: '   \n ' }).linearTransitionStateName).toBe('In Review');
    expect(normalizeIssueWritebackSettings({ linearTransitionStateName: 5 }).linearTransitionStateName).toBe('In Review');
  });

  it('drops unknown fields', () => {
    const result = normalizeIssueWritebackSettings({ evil: true });
    expect(result).not.toHaveProperty('evil');
  });
});
