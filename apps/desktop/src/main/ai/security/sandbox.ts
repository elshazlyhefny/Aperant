/**
 * Optional OS-level sandbox for the Bash tool.
 *
 * zeenha fork: wraps the shell invocation with bubblewrap (Linux) or
 * sandbox-exec (macOS), or a Windows AppContainer (via a PowerShell launcher,
 * see sandbox-windows.ts), so the home directory (and its credentials) is hidden.
 * Fails closed: if a sandbox is requested but cannot be built, the caller must
 * refuse to run the command instead of running it unsandboxed.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findExecutable, isLinux, isMacOS } from '../../platform/index';
import { buildWindows, resolvePowerShell } from './sandbox-windows';

export type SandboxMode = 'off' | 'home-hidden' | 'home-hidden-no-network';

export interface SandboxOptions {
  mode: SandboxMode;
  cwd: string;
  projectDir: string;
  writablePaths: string[];
  homeDir?: string;
  find?: (name: string) => string | null;
  platformName?: 'linux' | 'darwin' | 'win32';
}

export type SandboxResult =
  | { ok: true; file: string; args: string[] }
  | { ok: false; reason: string };

export function parseSandboxMode(value: unknown): SandboxMode {
  return value === 'home-hidden' || value === 'home-hidden-no-network' ? value : 'off';
}

function resolvePlatform(override?: SandboxOptions['platformName']): 'linux' | 'darwin' | 'win32' {
  if (override) return override;
  if (isLinux()) return 'linux';
  if (isMacOS()) return 'darwin';
  return 'win32';
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.filter((p) => p && p.length > 0))];
}

function buildLinux(
  shell: string,
  shellArgs: string[],
  opts: SandboxOptions,
  home: string,
  bwrap: string
): SandboxResult {
  const args: string[] = [
    '--ro-bind', '/', '/',
    '--tmpfs', home,
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
  ];

  for (const p of uniquePaths([opts.cwd, opts.projectDir, ...opts.writablePaths])) {
    args.push('--bind', p, p);
  }
  for (const rel of ['.gitconfig', path.join('.config', 'git')]) {
    const p = path.join(home, rel);
    if (fs.existsSync(p)) args.push('--ro-bind', p, p);
  }

  args.push('--die-with-parent');
  if (opts.mode === 'home-hidden-no-network') args.push('--unshare-net');
  args.push('--', shell, ...shellArgs);
  return { ok: true, file: bwrap, args };
}

function sbString(value: string): string | null {
  if (/["\\\n\r\0]/.test(value)) return null;
  return `"${value}"`;
}

function buildMac(
  shell: string,
  shellArgs: string[],
  opts: SandboxOptions,
  home: string,
  sandboxExec: string
): SandboxResult {
  const allowed = uniquePaths([opts.cwd, opts.projectDir, ...opts.writablePaths]);
  const homeLit = sbString(home);
  if (!homeLit) return { ok: false, reason: 'Sandbox refused: home directory path contains unsafe characters.' };

  const allowLits: string[] = [];
  for (const p of allowed) {
    const lit = sbString(p);
    if (!lit) return { ok: false, reason: `Sandbox refused: path contains unsafe characters: ${JSON.stringify(p)}` };
    allowLits.push(lit);
  }
  for (const rel of ['.gitconfig', path.join('.config', 'git')]) {
    const p = path.join(home, rel);
    const lit = sbString(p);
    if (lit && fs.existsSync(p)) allowLits.push(lit);
  }

  const lines = ['(version 1)', '(allow default)', `(deny file-read* file-write* (subpath ${homeLit}))`];
  if (allowLits.length > 0) {
    lines.push(`(allow file-read* file-write* ${allowLits.map((l) => `(subpath ${l})`).join(' ')})`);
  }
  if (opts.mode === 'home-hidden-no-network') lines.push('(deny network*)');

  return { ok: true, file: sandboxExec, args: ['-p', lines.join('\n'), shell, ...shellArgs] };
}

export function wrapForSandbox(
  shell: string,
  shellArgs: string[],
  options: SandboxOptions
): SandboxResult {
  if (options.mode === 'off') return { ok: true, file: shell, args: shellArgs };

  const platform = resolvePlatform(options.platformName);
  const find = options.find ?? ((name: string) => findExecutable(name));
  const home = options.homeDir ?? os.homedir();

  if (platform === 'linux') {
    const bwrap = find('bwrap');
    if (!bwrap) {
      return { ok: false, reason: 'Bash sandbox requested but bubblewrap (bwrap) was not found. Install it or disable the sandbox.' };
    }
    return buildLinux(shell, shellArgs, options, home, bwrap);
  }
  if (platform === 'darwin') {
    const exec = find('sandbox-exec');
    if (!exec) {
      return { ok: false, reason: 'Bash sandbox requested but sandbox-exec was not found. Disable the sandbox.' };
    }
    return buildMac(shell, shellArgs, options, home, exec);
  }
  // zeenha fork: Windows uses an AppContainer launched through PowerShell.
  const powershell = resolvePowerShell(options.find);
  if (!powershell) {
    return { ok: false, reason: 'Bash sandbox requested but powershell.exe was not found on Windows. Disable the sandbox to run commands.' };
  }
  return buildWindows(shell, shellArgs, options, home, powershell);
}
