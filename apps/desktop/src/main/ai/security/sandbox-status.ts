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

  // zeenha fork: 'restricted-rights' exists only on Windows, and Windows offers nothing else.
  const unixOnly: SandboxMode[] = ['restricted-rights'];
  if (platform === 'linux') {
    return find('bwrap')
      ? { state: 'available', tool: 'bwrap', installHint: null, unsupportedModes: unixOnly }
      : { state: 'tool-missing', tool: 'bwrap', installHint: 'bubblewrap', unsupportedModes: unixOnly };
  }
  if (platform === 'darwin') {
    return find('sandbox-exec')
      ? { state: 'available', tool: 'sandbox-exec', installHint: null, unsupportedModes: unixOnly }
      : { state: 'tool-missing', tool: 'sandbox-exec', installHint: null, unsupportedModes: unixOnly };
  }
  // zeenha fork: Windows runs 'restricted-rights' (restricted token + Job object)
  // through a PowerShell launcher. Git Bash cannot run with the profile hidden,
  // so both home-hidden modes are refused.
  const windowsUnsupported: SandboxMode[] = ['home-hidden', 'home-hidden-no-network'];
  return resolvePowerShell(opts.find)
    ? { state: 'available', tool: 'powershell', installHint: null, unsupportedModes: windowsUnsupported }
    : { state: 'tool-missing', tool: 'powershell', installHint: null, unsupportedModes: windowsUnsupported };
}

export { deriveSandboxStatus } from '../../../shared/utils/sandbox-status';
