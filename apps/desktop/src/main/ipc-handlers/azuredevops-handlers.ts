/**
 * Azure DevOps Handlers Entry Point
 *
 * Delegates to the modular handlers in the azuredevops/ directory.
 *
 * zeenha fork: Azure DevOps support does not exist upstream.
 */

import { registerAzureDevOpsHandlers } from './azuredevops/index';

export { registerAzureDevOpsHandlers };

/**
 * Default export for consistency with other handler modules
 */
export default function setupAzureDevOpsHandlers(): void {
  registerAzureDevOpsHandlers();
}
