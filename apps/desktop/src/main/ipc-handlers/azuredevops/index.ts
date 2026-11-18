/**
 * Azure DevOps IPC Handlers Module
 *
 * Exports the main registration function for all Azure DevOps-related IPC handlers.
 *
 * zeenha fork: Azure DevOps support does not exist upstream.
 */

import { registerCheckConnection, registerDetectRepository } from './connection-handlers';
import {
  registerGetPullRequests,
  registerGetPullRequest,
  registerGetPullRequestDiff,
  registerPostPullRequestComment
} from './pull-request-handlers';
import { registerAzureDevOpsReviewHandlers } from './review-handlers';
import { registerAzureDevOpsPostReview } from './review-posting';
import type { BrowserWindow } from 'electron';
import { createDebugLog } from '../../../shared/utils/debug-logger';

const debugLog = createDebugLog('AzureDevOps');

/**
 * Register all Azure DevOps IPC handlers
 */
export function registerAzureDevOpsHandlers(getMainWindow: () => BrowserWindow | null): void {
  debugLog('Registering all Azure DevOps handlers');

  registerCheckConnection();
  registerDetectRepository();
  registerGetPullRequests();
  registerGetPullRequest();
  registerGetPullRequestDiff();
  registerPostPullRequestComment();
  registerAzureDevOpsReviewHandlers(getMainWindow);
  registerAzureDevOpsPostReview();

  debugLog('All Azure DevOps handlers registered');
}
