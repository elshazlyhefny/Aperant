/**
 * Shared types for the CLI tool table (see specs.ts).
 */

import type { ToolDetectionResult } from '../../shared/types';
import type { WindowsToolPaths } from '../utils/windows-paths';

/** Supported CLI tools managed by the CLI tool manager */
export type CLITool = 'python' | 'git' | 'gh' | 'glab' | 'claude';

/** Result of validating one candidate executable */
export interface ToolValidation {
  valid: boolean;
  version?: string;
  message: string;
}

/** Key of the user-configured path for a tool */
export type ToolConfigKey =
  | 'pythonPath'
  | 'gitPath'
  | 'githubCLIPath'
  | 'gitlabCLIPath'
  | 'claudePath';

/** Environment facts candidates() depends on; built at call time, never at module load */
export interface DetectionContext {
  os: 'win32' | 'darwin' | 'linux';
  homeDir: string;
  isPackaged: boolean;
  resourcesPath: string;
}

type CandidateBase = {
  source: ToolDetectionResult['source'];
  /** Message prefix, e.g. 'Using Homebrew Git' (result message is `${message}: ${path}`) */
  message: string;
};

type CandidateLocation =
  /** A fixed path, used when it exists */
  | { kind: 'path'; path: string }
  /** A command validated as-is, e.g. 'py -3' */
  | { kind: 'command'; command: string }
  /** Resolved through findExecutable[Async] */
  | { kind: 'lookup'; exe: string }
  /** Resolved through findWindowsExecutableViaWhere[Async] (Windows only) */
  | { kind: 'where'; exe: string }
  /** Resolved through getWindowsExecutablePaths[Async] (already existence and security checked) */
  | { kind: 'windows-patterns'; patterns: WindowsToolPaths }
  /** Scan of an NVM node versions directory for `<version>/bin/<bin>` */
  | { kind: 'nvm'; dir: string; bin: string };

export type Candidate = CandidateBase & CandidateLocation;

/** Everything that differs between CLI tools */
export interface ToolSpec {
  tool: CLITool;
  /** Human label used in messages and logs, e.g. 'GitHub CLI' */
  label: string;
  configKey: ToolConfigKey;
  /** Executable name */
  exe: string;
  /** Candidates in detection order (after the user-configured path) */
  candidates(ctx: DetectionContext): Candidate[];
  /** Extract a version from `--version` output; null means "no usable version" */
  parseVersion(stdout: string): string | null;
  minVersion?: string;
  /** Allow commands with arguments such as 'py -3' */
  splitCommandArgs?: boolean;
  /** Require isSecurePath() for user-configured paths on Windows */
  secureUserConfigOnWindows?: boolean;
  /** Message when nothing was found */
  notFound: string;
}
