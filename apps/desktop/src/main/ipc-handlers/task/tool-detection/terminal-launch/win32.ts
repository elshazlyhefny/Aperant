import { existsSync } from 'fs';
import path from 'path';
import type { SupportedTerminal } from '../../../../../shared/types';
import { escapeGitBashCommand, escapePowerShellCommand } from '../path-safety';
import { TERMINAL_DETECTION } from '../tables';
import { spawnWindowsTerminal, withDirArg } from './spawn';
import type { LaunchOptions, Launcher } from './types';

/** Return the first path that exists, or undefined. */
export function findFirstExisting(paths: string[]): string | undefined {
  return paths.filter(Boolean).find((p) => existsSync(p));
}

/** Command text for PowerShell: optionally change directory first, then escape for -Command. */
const toPowerShellCommand = (command: string, cwd?: string): string => {
  const line = cwd ? `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'; ${command}` : command;
  return escapePowerShellCommand(line);
};

const toBashCommand = (command: string, cwd?: string): string => {
  const line = cwd ? `cd '${cwd.replace(/'/g, "'\\''")}' && ${command}` : command;
  return escapeGitBashCommand(line);
};

const runInPowerShell = (command: string, cwd?: string): Promise<void> =>
  spawnWindowsTerminal('powershell', ['-NoExit', '-Command', toPowerShellCommand(command, cwd)]);

/**
 * Launcher that needs an executable found on disk; falls back to PowerShell if it is missing.
 * `build` receives the executable path and returns its args.
 */
const locatedLauncher = (
  name: string,
  candidates: () => string[],
  build: (exe: string, command: string, cwd?: string) => string[],
): Launcher => async ({ command, cwd }) => {
  const exe = findFirstExisting(candidates());
  if (exe && command) return spawnWindowsTerminal(exe, build(exe, command, cwd));
  if (exe) return spawnWindowsTerminal(exe, []);
  console.warn(`[terminal-launch] ${name} not found, falling back to PowerShell`);
  return runInPowerShell(command ?? '', cwd);
};

/** Terminals that cannot run a command: open them and the user pastes it. */
const openOnlyLauncher = (name: string, candidates: () => string[]): Launcher => async ({ command, cwd }) => {
  const exe = findFirstExisting(candidates());
  if (exe) return spawnWindowsTerminal(exe, []);
  console.warn(`[terminal-launch] ${name} not found, falling back to PowerShell`);
  return runInPowerShell(command ?? '', cwd);
};

const localAppData = (...parts: string[]) => [
  path.join(process.env.LOCALAPPDATA || '', 'Programs', ...parts),
  path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Programs', ...parts),
];

const powershellLauncher: Launcher = ({ command, cwd }) => runInPowerShell(command ?? '', cwd);

const WIN32_COMMAND_LAUNCHERS: Partial<Record<SupportedTerminal, Launcher>> = {
  windowsterminal: ({ command, cwd }) =>
    spawnWindowsTerminal('wt', ['new-tab', 'powershell', '-NoExit', '-Command', toPowerShellCommand(command ?? '', cwd)]),
  powershell: powershellLauncher,
  cmd: ({ command, cwd }) => {
    const cmdPath = process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
    return spawnWindowsTerminal(cmdPath, ['/k', 'powershell', '-NoExit', '-Command', toPowerShellCommand(command ?? '', cwd)]);
  },
  gitbash: async ({ command, cwd }) => {
    const gitBashPath = findFirstExisting([
      'C:\\Program Files\\Git\\git-bash.exe',
      'C:\\Program Files (x86)\\Git\\git-bash.exe',
    ]);
    if (!gitBashPath) throw new Error('Git Bash not found');
    return spawnWindowsTerminal(gitBashPath, ['-c', toBashCommand(command ?? '', cwd)]);
  },
  alacritty: ({ command, cwd }) =>
    spawnWindowsTerminal('alacritty', ['-e', 'powershell', '-NoExit', '-Command', toPowerShellCommand(command ?? '', cwd)]),
  wezterm: ({ command, cwd }) =>
    spawnWindowsTerminal('wezterm', ['start', '--', 'powershell', '-NoExit', '-Command', toPowerShellCommand(command ?? '', cwd)]),
  conemu: locatedLauncher(
    'ConEmu',
    () => ['C:\\Program Files\\ConEmu\\ConEmu64.exe', 'C:\\Program Files (x86)\\ConEmu\\ConEmu.exe'],
    (_exe, command, cwd) => ['-run', `powershell -NoExit -Command ${toPowerShellCommand(command, cwd)}`],
  ),
  cmder: locatedLauncher(
    'Cmder',
    () => ['C:\\cmder\\Cmder.exe', 'C:\\tools\\cmder\\Cmder.exe', path.join(process.env.CMDER_ROOT || '', 'Cmder.exe')],
    (_exe, command, cwd) => ['/SINGLE', '/START', '', '/TASK', `powershell -NoExit -Command ${toPowerShellCommand(command, cwd)}`],
  ),
  hyper: openOnlyLauncher('Hyper', () => localAppData('Hyper', 'Hyper.exe')),
  tabby: openOnlyLauncher('Tabby', () => localAppData('Tabby', 'Tabby.exe')),
  cygwin: locatedLauncher(
    'Cygwin',
    () => ['C:\\cygwin64\\bin\\mintty.exe', 'C:\\cygwin\\bin\\mintty.exe'],
    (_exe, command, cwd) => ['-e', '/bin/bash', '-lc', toBashCommand(command, cwd)],
  ),
  msys2: locatedLauncher(
    'MSYS2',
    () => ['C:\\msys64\\msys2_shell.cmd', 'C:\\msys64\\mingw64.exe', 'C:\\msys64\\usr\\bin\\mintty.exe'],
    (exe, command, cwd) =>
      exe.endsWith('.cmd')
        ? ['-mingw64', '-c', toBashCommand(command, cwd)]
        : ['-e', '/bin/bash', '-lc', toBashCommand(command, cwd)],
  ),
};

/** Open a terminal at a directory (no command), using the TERMINAL_DETECTION command for the terminal. */
const openAtDirectory = (terminal: string, cwd?: string): Promise<void> => {
  if (terminal === 'system') {
    return spawnWindowsTerminal('cmd.exe', cwd ? ['/K', 'cd', '/d', cwd] : ['/K']);
  }
  const commands = TERMINAL_DETECTION[terminal as SupportedTerminal]?.commands.win32;
  if (!commands || commands.length === 0) {
    return spawnWindowsTerminal('powershell', cwd ? ['-NoExit', '-Command', 'cd', cwd] : ['-NoExit']);
  }
  const { cmd, args } = withDirArg(commands, cwd);
  return spawnWindowsTerminal(cmd, args);
};

export const launchWin32 = (opts: LaunchOptions): Promise<void> => {
  const terminal = (opts.terminal ? String(opts.terminal) : 'powershell').toLowerCase();
  if (!opts.command) return openAtDirectory(terminal, opts.cwd);
  // Default: PowerShell (handles 'powershell', 'system', or any unknown value)
  const launcher = WIN32_COMMAND_LAUNCHERS[terminal as SupportedTerminal] ?? powershellLauncher;
  return launcher({ ...opts, terminal });
};
