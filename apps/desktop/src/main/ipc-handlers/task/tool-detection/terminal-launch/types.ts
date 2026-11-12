import type { SupportedTerminal } from '../../../../../shared/types';

/**
 * Options for launching a terminal.
 * - cwd only: open a terminal at that directory
 * - command only: open a terminal and run the command
 * - both: open a terminal at cwd and run the command there
 */
export interface LaunchOptions {
  /** Terminal id (from settings.preferredTerminal); unknown/undefined values use the platform default */
  terminal: SupportedTerminal | string | undefined;
  cwd?: string;
  command?: string;
}

/** A platform/terminal specific launcher. Resolves once the terminal has been started. */
export type Launcher = (opts: LaunchOptions) => Promise<void>;
