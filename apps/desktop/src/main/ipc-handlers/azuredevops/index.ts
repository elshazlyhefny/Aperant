/**
 * Azure DevOps IPC Handlers Module
 *
 * Exports the main registration function for all Azure DevOps-related IPC handlers.
 */

import { registerCheckConnection, registerDetectRepository } from './connection-handlers';
import { createDebugLog } from '../../../shared/utils/debug-logger';

const debugLog = createDebugLog('AzureDevOps');

/**
 * Register all Azure DevOps IPC handlers
 */
export function registerAzureDevOpsHandlers(): void {
  debugLog('Registering all Azure DevOps handlers');

  registerCheckConnection();
  registerDetectRepository();

  debugLog('All Azure DevOps handlers registered');
}
