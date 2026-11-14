/**
 * Bitbucket Handlers Entry Point
 *
 * Delegates to the modular handlers in the bitbucket/ directory.
 */

import type { BrowserWindow } from 'electron';
import { registerBitbucketHandlers } from './bitbucket/index';

export { registerBitbucketHandlers };

/**
 * Default export for consistency with other handler modules
 */
export default function setupBitbucketHandlers(getMainWindow: () => BrowserWindow | null): void {
  registerBitbucketHandlers(getMainWindow);
}
