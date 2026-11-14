/**
 * Azure DevOps Handlers Entry Point
 *
 * Delegates to the modular handlers in the azuredevops/ directory.
 */

import { registerAzureDevOpsHandlers } from './azuredevops/index';

export { registerAzureDevOpsHandlers };

/**
 * Default export for consistency with other handler modules
 */
export default function setupAzureDevOpsHandlers(): void {
  registerAzureDevOpsHandlers();
}
