/**
 * Optional OS-level sandbox for the Bash tool.
 *
 * zeenha fork: wraps the shell invocation with bubblewrap (Linux) or
 * sandbox-exec (macOS) so the home directory (and its credentials) is hidden.
 * On Windows only the weaker 'restricted-rights' mode exists: a restricted token
 * plus a Job object (via a PowerShell launcher, see sandbox-windows.ts) that
 * does not hide the home directory; the home-hidden modes are refused there.
 * Both home-hidden modes also mask `<project>/.auto-claude/.env*` (the integration
 * token file), including the main project's copy behind a task worktree: bwrap
 * overlays /dev/null on it, sandbox-exec denies read/write on it. Windows
 * 'restricted-rights' has no filesystem hiding, so there the token file relies on
 * the file-tool block and the command validator only.
 * Fails closed: if a sandbox is requested but cannot be built, the caller must
 * refuse to run the command instead of running it unsandboxed.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findExecutable, isLinux, isMacOS } from '../../platform/index';
import { buildWindows, resolvePowerShell, WINDOWS_HOME_HIDDEN_REFUSAL } from './sandbox-windows';

/**
 * 'restricted-rights' is Windows only: it drops admin rights and privileges and
 * kills leftover child processes, but does not hide the home directory or
 * block the network. The home-hidden modes are Linux and macOS only.
 */
export type SandboxMode = 'off' | 'home-hidden' | 'home-hidden-no-network' | 'restricted-rights';

export const RESTRICTED_RIGHTS_WINDOWS_ONLY =
  'The "restricted rights" Bash sandbox mode is only available on Windows. Choose a "home hidden" mode or turn the sandbox off.';

export interface SandboxOptions {
  mode: SandboxMode;
  cwd: string;
  projectDir: string;
  writablePaths: string[];
  homeDir?: string;
  find?: (name: string) => string | null;
  platformName?: 'linux' | 'darwin' | 'win32';
  /** Windows only: where the launcher script is written. Defaults to os.tmpdir(). */
  launcherDir?: string;
}

export type SandboxResult =
  | { ok: true; file: string; args: string[] }
  | { ok: false; reason: string };

export function parseSandboxMode(value: unknown): SandboxMode {
  return value === 'home-hidden' || value === 'home-hidden-no-network' || value === 'restricted-rights'
    ? value
    : 'off';
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

/**
 * Derive the main project root from a task worktree path. Worktrees live at
 * `<main>/.auto-claude/worktrees/...` (or legacy `<main>/.worktrees/<id>`).
 */
function mainRootOf(dir: string): string | null {
  for (const marker of [
    `${path.sep}.auto-claude${path.sep}worktrees${path.sep}`,
    `${path.sep}.worktrees${path.sep}`,
  ]) {
    const idx = dir.indexOf(marker);
    if (idx > 0) return dir.slice(0, idx);
  }
  return null;
}

function secretEnvRoots(opts: Pick<SandboxOptions, 'cwd' | 'projectDir'>): string[] {
  const roots = [opts.projectDir, opts.cwd].filter((p) => p && p.length > 0);
  for (const r of [...roots]) {
    const main = mainRootOf(r);
    if (main) roots.push(main);
  }
  return uniquePaths(roots);
}

/**
 * Absolute paths of existing `<root>/.auto-claude/.env*` files (the project,
 * the cwd and the main project root behind a task worktree) that the sandbox
 * must hide, because bwrap binds `/` read-only and would otherwise expose them.
 */
export function collectSecretEnvFiles(opts: Pick<SandboxOptions, 'cwd' | 'projectDir'>): string[] {
  const found: string[] = [];
  for (const root of secretEnvRoots(opts)) {
    const dir = path.join(root, '.auto-claude');
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith('.env')) continue;
      const file = path.join(dir, name);
      try {
        const st = fs.lstatSync(file);
        if (st.isFile() || st.isSymbolicLink()) found.push(file);
      } catch {
        // unreadable entry: skip
      }
    }
  }
  return uniquePaths(found);
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

  // Later mounts overlay earlier ones: hide the token file(s) after the binds.
  for (const file of collectSecretEnvFiles(opts)) {
    args.push('--ro-bind', '/dev/null', file);
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
  // Last matching rule wins, so the token-file denies go after the allow line.
  const denyPaths = uniquePaths([
    ...secretEnvRoots(opts).map((r) => path.join(r, '.auto-claude', '.env')),
    ...collectSecretEnvFiles(opts),
  ]);
  for (const p of denyPaths) {
    const lit = sbString(p);
    if (!lit) return { ok: false, reason: `Sandbox refused: path contains unsafe characters: ${JSON.stringify(p)}` };
    lines.push(`(deny file-read* file-write* (literal ${lit}))`);
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
  if (options.mode === 'restricted-rights' && platform !== 'win32') {
    return { ok: false, reason: RESTRICTED_RIGHTS_WINDOWS_ONLY };
  }
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
  // zeenha fork: Windows only offers 'restricted-rights' (restricted token + Job
  // object, launched through PowerShell). The home-hidden modes are refused.
  if (options.mode !== 'restricted-rights') {
    return { ok: false, reason: WINDOWS_HOME_HIDDEN_REFUSAL };
  }
  const powershell = resolvePowerShell(options.find);
  if (!powershell) {
    return { ok: false, reason: 'Bash sandbox requested but powershell.exe was not found on Windows. Disable the sandbox to run commands.' };
  }
  return buildWindows(shell, shellArgs, options, powershell);
}
