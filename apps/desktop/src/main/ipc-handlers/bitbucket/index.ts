/**
 * Bitbucket IPC Handlers Module
 *
 * Exports the main registration function for all Bitbucket-related IPC handlers.
 */

import {
  registerCheckConnection,
  registerDetectRepository,
  registerGetPullRequests,
  registerGetPullRequest,
  registerGetPullRequestDiff,
  registerPostPullRequestComment
} from './pull-request-handlers';
import { createDebugLog } from '../../../shared/utils/debug-logger';

const debugLog = createDebugLog('Bitbucket');

/**
 * Register all Bitbucket IPC handlers
 */
export function registerBitbucketHandlers(): void {
  debugLog('Registering all Bitbucket handlers');

  registerCheckConnection();
  registerDetectRepository();
  registerGetPullRequests();
  registerGetPullRequest();
  registerGetPullRequestDiff();
  registerPostPullRequestComment();

  debugLog('All Bitbucket handlers registered');
}
