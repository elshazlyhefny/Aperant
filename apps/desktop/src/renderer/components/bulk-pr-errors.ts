import type { WorktreeCreatePRErrorCode } from '../../shared/types';

/**
 * Error codes for which a task is reported as 'skipped' (nothing to create a PR from)
 * rather than 'error' in the bulk PR dialog.
 */
export const SKIPPED_ERROR_CODES: readonly WorktreeCreatePRErrorCode[] = [
  'NO_WORKTREE',
  'TASK_NOT_FOUND',
  'SPEC_DIR_NOT_FOUND'
];

export function isSkippedErrorCode(code: WorktreeCreatePRErrorCode | undefined): boolean {
  return code !== undefined && SKIPPED_ERROR_CODES.includes(code);
}

/**
 * Returns the i18n key for an error code, or null when the server-provided
 * message should be shown instead (NO_CHANGES, GH_FAILED and MR_FAILED carry specific
 * details; UNKNOWN / missing codes have no dedicated text).
 */
export function getBulkPRErrorMessageKey(code: WorktreeCreatePRErrorCode | undefined): string | null {
  switch (code) {
    case 'NO_WORKTREE':
      return 'taskReview:bulkPR.noWorktree';
    case 'TASK_NOT_FOUND':
      return 'taskReview:bulkPR.errors.taskNotFound';
    case 'SPEC_DIR_NOT_FOUND':
      return 'taskReview:bulkPR.errors.specDirNotFound';
    case 'INVALID_TARGET_BRANCH':
      return 'taskReview:bulkPR.errors.invalidTargetBranch';
    case 'INVALID_TITLE_LENGTH':
      return 'taskReview:bulkPR.errors.invalidTitleLength';
    case 'INVALID_TITLE_CHARS':
      return 'taskReview:bulkPR.errors.invalidTitleChars';
    case 'BRANCH_REFUSED':
      return 'taskReview:bulkPR.errors.branchRefused';
    case 'COMMIT_FAILED':
      return 'taskReview:bulkPR.errors.commitFailed';
    case 'PUSH_FAILED':
      return 'taskReview:bulkPR.errors.pushFailed';
    case 'GH_TIMEOUT':
      return 'taskReview:bulkPR.errors.ghTimeout';
    case 'RETRIES_EXHAUSTED':
      return 'taskReview:bulkPR.errors.retriesExhausted';
    default:
      // NO_CHANGES, GH_FAILED, MR_FAILED, UNKNOWN, undefined: use the server message
      return null;
  }
}
