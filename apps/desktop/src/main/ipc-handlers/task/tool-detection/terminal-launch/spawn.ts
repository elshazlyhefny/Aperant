import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { escapeSingleQuotedPath } from '../path-safety';

const execFileAsync = promisify(execFile);

/** Give a Windows terminal a brief moment to open its window without making the UI feel sluggish. */
export const SPAWN_WAIT_MS = 300;

/**
 * Spawn a process that outlives the app and does not block on its output.
 * Rejects if the executable cannot be started (e.g. ENOENT) so callers can fall back.
 */
export function spawnDetached(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => resolve());
    child.unref();
  });
}

/**
 * Spawn a detached Windows terminal. Spawning the executable directly is more reliable than
 * exec() + `start`, and detached lets the terminal persist after the app exits.
 * Resolves after SPAWN_WAIT_MS unless the spawn errors first.
 */
export function spawnWindowsTerminal(executable: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });

    child.unref();

    const timer = setTimeout(() => {
      child.removeListener('error', onError);
      resolve();
    }, SPAWN_WAIT_MS);

    const onError = (err: Error) => {
      clearTimeout(timer);
      reject(err);
    };

    child.on('error', onError);
  });
}

/** Run an AppleScript through osascript. */
export async function runAppleScript(script: string): Promise<void> {
  await execFileAsync('osascript', ['-e', script]);
}

/** Run a command to completion (used for short-lived launchers such as `open -a`). */
export async function runFile(cmd: string, args: string[]): Promise<void> {
  await execFileAsync(cmd, args);
}

/**
 * Build a single shell line from an optional command and optional working directory.
 * The command is passed through unchanged (callers rely on its `;` separators).
 */
export function toShellLine(command?: string, cwd?: string): string {
  const cd = cwd ? `cd '${escapeSingleQuotedPath(cwd)}'` : '';
  if (cd && command) return `${cd} && ${command}`;
  return cd || command || '';
}

/**
 * Append the directory argument to a TERMINAL_DETECTION command.
 * Entries ending in '=' (e.g. '--working-directory=') take the directory as part of the same argument.
 */
export function withDirArg(commands: string[], cwd?: string): { cmd: string; args: string[] } {
  const [cmd, ...rest] = commands;
  if (!cwd) return { cmd, args: rest };
  const last = rest[rest.length - 1];
  if (last?.endsWith('=')) {
    return { cmd, args: [...rest.slice(0, -1), `${last}${cwd}`] };
  }
  return { cmd, args: [...rest, cwd] };
}
