import { describe, expect, it } from 'vitest';
import { verdictToOverallStatus } from '../review-verdict';

describe('verdictToOverallStatus', () => {
  it('maps ready_to_merge to approve', () => {
    expect(verdictToOverallStatus('ready_to_merge')).toBe('approve');
  });

  it('maps merge_with_changes to comment', () => {
    expect(verdictToOverallStatus('merge_with_changes')).toBe('comment');
  });

  it('maps needs_revision to request_changes', () => {
    expect(verdictToOverallStatus('needs_revision')).toBe('request_changes');
  });

  it('maps blocked to request_changes', () => {
    expect(verdictToOverallStatus('blocked')).toBe('request_changes');
  });

  it('falls back to comment for unknown verdicts', () => {
    expect(verdictToOverallStatus('something_else')).toBe('comment');
    expect(verdictToOverallStatus('toString')).toBe('comment');
  });

  it('falls back to comment for an empty string', () => {
    expect(verdictToOverallStatus('')).toBe('comment');
  });
});
