import { getCurrentOS } from '../../../../platform';
import { launchDarwin } from './darwin';
import { launchLinux } from './linux';
import { launchWin32 } from './win32';
import type { LaunchOptions } from './types';

export type { LaunchOptions, Launcher } from './types';

/**
 * Open a terminal using the platform launcher table.
 * - `cwd` only: open the terminal at that directory
 * - `command`: run it in a new terminal (at `cwd` if given)
 * Throws if the terminal could not be started.
 */
export async function launchTerminal(opts: LaunchOptions): Promise<void> {
  const os = getCurrentOS() as 'darwin' | 'win32' | 'linux';
  if (os === 'darwin') {
    return launchDarwin(opts);
  }
  if (os === 'win32') {
    try {
      await launchWin32(opts);
    } catch (err) {
      throw new Error(`Failed to open terminal: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
    return;
  }
  return launchLinux(opts);
}
