/**
 * Bitbucket Handlers Entry Point
 *
 * Delegates to the modular handlers in the bitbucket/ directory.
 */

import { registerBitbucketHandlers } from './bitbucket/index';

export { registerBitbucketHandlers };

/**
 * Default export for consistency with other handler modules
 */
export default function setupBitbucketHandlers(): void {
  registerBitbucketHandlers();
}
