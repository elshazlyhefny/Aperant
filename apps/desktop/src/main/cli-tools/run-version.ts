/**
 * Version probe: runs `<tool> --version` once, in sync and async flavours.
 *
 * The command-line planning (quote stripping, Windows .cmd/.bat via cmd.exe,
 * security check) lives in planVersionCommand() so it exists exactly once.
 */

import {
  execFile,
  execFileSync,
  type ExecFileOptionsWithStringEncoding,
  type ExecFileSyncOptions,
} from 'child_process';
import path from 'path';
import { promisify } from 'util';
import { getAugmentedEnv, getAugmentedEnvAsync, shouldUseShell } from '../env-utils';
import { isSecurePath } from '../utils/windows-paths';

const execFileAsync = promisify(execFile);

export type ExecFileSyncOptionsWithVerbatim = ExecFileSyncOptions & {
  windowsVerbatimArguments?: boolean;
};
export type ExecFileAsyncOptionsWithVerbatim = ExecFileOptionsWithStringEncoding & {
  windowsVerbatimArguments?: boolean;
};

/** Thrown when a .cmd/.bat path on Windows fails isSecurePath(); the message is shown to the user as-is */
export class InsecurePathError extends Error {
  constructor(label: string, unquoted: string) {
    super(`${label} path failed security validation: ${unquoted}`);
    this.name = 'InsecurePathError';
  }
}

interface VersionCommandPlan {
  file: string;
  args: string[];
  options: {
    encoding: 'utf-8';
    timeout: number;
    windowsHide: true;
    shell?: false;
    windowsVerbatimArguments?: true;
  };
  /** Directory of the executable, to be put on PATH ('' when there is none) */
  cmdDir: string;
}

/** Pure: decide how to execute `cmd args` */
export function planVersionCommand(cmd: string, args: string[], label = 'CLI'): VersionCommandPlan {
  const trimmed = cmd.trim();
  const unquoted =
    trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
  const dir = path.dirname(unquoted);
  const cmdDir = dir && dir !== '.' ? dir : '';
  const base = { encoding: 'utf-8' as const, timeout: 5000, windowsHide: true as const };

  if (shouldUseShell(trimmed)) {
    // .cmd/.bat on Windows: run through cmd.exe with a quoted command line.
    // /d = no AutoRun, /s = keep inner quotes (paths with spaces), /c = run and exit
    if (!isSecurePath(unquoted)) {
      throw new InsecurePathError(label, unquoted);
    }
    const cmdExe =
      process.env.ComSpec ||
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
    return {
      file: cmdExe,
      args: ['/d', '/s', '/c', `""${unquoted}" ${args.join(' ')}"`],
      options: { ...base, windowsVerbatimArguments: true },
      cmdDir,
    };
  }

  return { file: unquoted, args, options: { ...base, shell: false }, cmdDir };
}

const normalize = (output: string | Buffer): string =>
  typeof output === 'string' ? output : output.toString('utf-8');

/** Run the version probe synchronously; returns raw stdout */
export function runVersion(cmd: string, args: string[], label?: string): string {
  const plan = planVersionCommand(cmd, args, label);
  const env = getAugmentedEnv(plan.cmdDir ? [plan.cmdDir] : []);
  return normalize(execFileSync(plan.file, plan.args, { ...plan.options, env }));
}

/** Run the version probe asynchronously; returns raw stdout */
export async function runVersionAsync(cmd: string, args: string[], label?: string): Promise<string> {
  const plan = planVersionCommand(cmd, args, label);
  const env = await getAugmentedEnvAsync(plan.cmdDir ? [plan.cmdDir] : []);
  const { stdout } = await execFileAsync(plan.file, plan.args, { ...plan.options, env });
  return String(stdout);
}
