/**
 * Azure DevOps Handlers Entry Point
 *
 * Delegates to the modular handlers in the azuredevops/ directory.
 *
 * zeenha fork: Azure DevOps support does not exist upstream.
 */

import type { BrowserWindow } from 'electron';
import { registerAzureDevOpsHandlers } from './azuredevops/index';

export { registerAzureDevOpsHandlers };

/**
 * Default export for consistency with other handler modules
 */
export default function setupAzureDevOpsHandlers(getMainWindow: () => BrowserWindow | null): void {
  registerAzureDevOpsHandlers(getMainWindow);
}
