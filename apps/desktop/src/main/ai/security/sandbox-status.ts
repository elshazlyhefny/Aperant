/**
 * Detects whether the OS-level Bash sandbox can run on this machine.
 *
 * zeenha fork: lets the UI show if the sandbox tool is installed, independent
 * of whether the user has turned the sandbox on.
 */

import { findExecutable, isLinux, isMacOS } from '../../platform/index';
import type { SandboxMode } from './sandbox';
import { resolvePowerShell } from './sandbox-windows';

export interface SandboxAvailability {
  state: 'available' | 'tool-missing' | 'unsupported';
  tool: 'bwrap' | 'sandbox-exec' | 'powershell' | null;
  installHint: 'bubblewrap' | null;
  unsupportedModes?: SandboxMode[];
}

export type SandboxStatus = 'active' | 'available-off' | 'tool-missing' | 'unsupported' | 'mode-unsupported';

export interface SandboxAvailabilityOptions {
  find?: (name: string) => string | null;
  platformName?: 'linux' | 'darwin' | 'win32';
}

function resolvePlatform(override?: SandboxAvailabilityOptions['platformName']): 'linux' | 'darwin' | 'win32' {
  if (override) return override;
  if (isLinux()) return 'linux';
  if (isMacOS()) return 'darwin';
  return 'win32';
}

export function getSandboxAvailability(opts: SandboxAvailabilityOptions = {}): SandboxAvailability {
  const platform = resolvePlatform(opts.platformName);
  const find = opts.find ?? ((name: string) => findExecutable(name));

  if (platform === 'linux') {
    return find('bwrap')
      ? { state: 'available', tool: 'bwrap', installHint: null }
      : { state: 'tool-missing', tool: 'bwrap', installHint: 'bubblewrap' };
  }
  if (platform === 'darwin') {
    return find('sandbox-exec')
      ? { state: 'available', tool: 'sandbox-exec', installHint: null }
      : { state: 'tool-missing', tool: 'sandbox-exec', installHint: null };
  }
  // zeenha fork: Windows runs the sandbox (restricted token + Job object) through
  // a PowerShell launcher. It cannot block the network, so that mode is refused.
  return resolvePowerShell(opts.find)
    ? { state: 'available', tool: 'powershell', installHint: null, unsupportedModes: ['home-hidden-no-network'] }
    : { state: 'tool-missing', tool: 'powershell', installHint: null, unsupportedModes: ['home-hidden-no-network'] };
}

export { deriveSandboxStatus } from '../../../shared/utils/sandbox-status';
