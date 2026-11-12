import { describe, expect, it } from 'vitest';
import { WORKTREE_CREATE_PR_ERROR_CODES } from '../../../shared/types';
import type { WorktreeCreatePRErrorCode } from '../../../shared/types';
import { getBulkPRErrorMessageKey, isSkippedErrorCode } from '../bulk-pr-errors';

const SKIPPED: WorktreeCreatePRErrorCode[] = ['NO_WORKTREE', 'TASK_NOT_FOUND', 'SPEC_DIR_NOT_FOUND'];
const SERVER_MESSAGE: WorktreeCreatePRErrorCode[] = ['NO_CHANGES', 'GH_FAILED', 'MR_FAILED', 'UNKNOWN'];

describe('isSkippedErrorCode', () => {
  it.each(WORKTREE_CREATE_PR_ERROR_CODES)('classifies %s', (code) => {
    expect(isSkippedErrorCode(code)).toBe(SKIPPED.includes(code));
  });

  it('is false for undefined and unrecognised codes', () => {
    expect(isSkippedErrorCode(undefined)).toBe(false);
    expect(isSkippedErrorCode('SOMETHING_ELSE' as WorktreeCreatePRErrorCode)).toBe(false);
  });
});

describe('getBulkPRErrorMessageKey', () => {
  it.each(WORKTREE_CREATE_PR_ERROR_CODES)('returns the expected key for %s', (code) => {
    const key = getBulkPRErrorMessageKey(code);
    if (SERVER_MESSAGE.includes(code)) {
      expect(key).toBeNull();
    } else {
      expect(key).toMatch(/^taskReview:bulkPR\./);
    }
  });

  it('falls back to the raw message (null key) for undefined and unrecognised codes', () => {
    expect(getBulkPRErrorMessageKey(undefined)).toBeNull();
    expect(getBulkPRErrorMessageKey('SOMETHING_ELSE' as WorktreeCreatePRErrorCode)).toBeNull();
  });
});
