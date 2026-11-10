/**
 * zeenha fork: single implementation of the Bash sandbox status rule, shared
 * by the main process and the settings UI.
 */

import type { BashSandboxMode, SandboxAvailability, SandboxStatusKind } from '../types/project';

export function deriveSandboxStatus(
  availability: SandboxAvailability,
  mode: BashSandboxMode
): SandboxStatusKind {
  if (availability.state === 'unsupported') return 'unsupported';
  if (availability.state === 'tool-missing') return 'tool-missing';
  return mode === 'off' ? 'available-off' : 'active';
}
