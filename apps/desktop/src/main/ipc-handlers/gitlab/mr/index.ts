/**
 * GitLab MR review IPC handlers (entry point)
 *
 * 1. Get MR diff, run AI review (including follow-up reviews), cancel
 * 2. Post review comments (notes)
 * 3. Merge, assign and approve
 */

import type { BrowserWindow } from 'electron';
import { createContextLogger } from '../../github/utils/logger';
import { registerMRReviewRunHandlers } from './review-handlers';
import { registerMRPostingHandlers } from './posting-handlers';
import { registerMRActionHandlers } from './action-handlers';

const { debug: debugLog } = createContextLogger('GitLab MR');

export type {
  MRReviewFinding,
  MRReviewResult,
  MRReviewProgress,
  NewCommitsCheck,
} from '../types';

/**
 * Register MR-related handlers
 */
export function registerMRReviewHandlers(getMainWindow: () => BrowserWindow | null): void {
  debugLog('Registering MR review handlers');

  registerMRReviewRunHandlers(getMainWindow);
  registerMRPostingHandlers();
  registerMRActionHandlers();

  debugLog('MR review handlers registered');
}
