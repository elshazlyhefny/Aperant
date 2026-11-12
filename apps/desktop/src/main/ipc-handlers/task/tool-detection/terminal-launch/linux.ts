import type { SupportedTerminal } from '../../../../../shared/types';
import { escapeSingleQuotedPath } from '../path-safety';
import { TERMINAL_DETECTION } from '../tables';
import { spawnDetached, toShellLine, withDirArg } from './spawn';
import type { LaunchOptions } from './types';

type Invocation = { cmd: string; args: string[] };
type CommandBuilder = (bashCommand: string) => Invocation;

const bashC = (cmd: string, flag: string): CommandBuilder => (line) => ({ cmd, args: [flag, 'bash', '-c', line] });
const quoted = (cmd: string): CommandBuilder => (line) => ({ cmd, args: ['-e', `bash -c "${line}"`] });

const LINUX_BUILDERS: Partial<Record<SupportedTerminal, CommandBuilder>> = {
  gnometerminal: bashC('gnome-terminal', '--'),
  konsole: bashC('konsole', '-e'),
  xfce4terminal: quoted('xfce4-terminal'),
  lxterminal: quoted('lxterminal'),
  'mate-terminal': quoted('mate-terminal'),
  tilix: bashC('tilix', '-e'),
  terminator: quoted('terminator'),
  guake: (line) => ({ cmd: 'guake', args: ['-e', line] }),
  yakuake: (line) => ({ cmd: 'yakuake', args: ['-e', line] }),
  kitty: bashC('kitty', '--'),
  alacritty: bashC('alacritty', '-e'),
  wezterm: (line) => ({ cmd: 'wezterm', args: ['start', '--', 'bash', '-c', line] }),
  hyper: () => ({ cmd: 'hyper', args: [] }),
  tabby: () => ({ cmd: 'tabby', args: [] }),
  xterm: bashC('xterm', '-e'),
  urxvt: bashC('urxvt', '-e'),
  st: bashC('st', '-e'),
  foot: (line) => ({ cmd: 'foot', args: ['bash', '-c', line] }),
};

/** Auto-detect order for 'system' or unknown terminals when a command is given. */
const AUTO_DETECT: CommandBuilder[] = [
  bashC('gnome-terminal', '--'),
  bashC('konsole', '-e'),
  quoted('xfce4-terminal'),
  bashC('tilix', '-e'),
  quoted('terminator'),
  bashC('kitty', '--'),
  bashC('alacritty', '-e'),
  bashC('xterm', '-e'),
];

async function firstThatSpawns(candidates: Invocation[]): Promise<void> {
  for (const { cmd, args } of candidates) {
    try {
      await spawnDetached(cmd, args);
      return;
    } catch {
      // try the next candidate
    }
  }
  throw new Error('No supported terminal emulator found');
}

/** Open a terminal at a directory (no command). */
async function openAtDirectory(terminal: string, cwd?: string): Promise<void> {
  const commands = TERMINAL_DETECTION[terminal as SupportedTerminal]?.commands.linux;
  if (terminal !== 'system' && commands && commands.length > 0 && terminal !== 'xterm') {
    const { cmd, args } = withDirArg(commands, cwd);
    await spawnDetached(cmd, args);
    return;
  }

  // 'system' / unknown / xterm: try common terminal emulators with proper argument arrays
  const dirArgs = cwd ? ['--working-directory', cwd] : [];
  // xterm doesn't have --working-directory, use -e with a script (path escaped for shell use)
  const xtermScript = cwd ? `cd '${escapeSingleQuotedPath(cwd)}' && bash` : 'bash';
  const xterm = { cmd: 'xterm', args: ['-e', xtermScript] };
  if (terminal === 'xterm') {
    await spawnDetached(xterm.cmd, xterm.args);
    return;
  }
  await firstThatSpawns([
    { cmd: 'x-terminal-emulator', args: [...dirArgs, '-e', 'bash'] },
    { cmd: 'gnome-terminal', args: dirArgs },
    xterm,
  ]);
}

export async function launchLinux(opts: LaunchOptions): Promise<void> {
  const terminal = (opts.terminal ? String(opts.terminal) : '').toLowerCase();
  if (!opts.command) return openAtDirectory(terminal || 'system', opts.cwd);

  // Command to run (keep terminal open after execution).
  // Note: Currently all commands come from trusted sources (getInstallCommand, getInstallVersionCommand),
  // which return multi-statement commands with semicolons as separators.
  // We do NOT escape these commands to preserve the semicolon command separators.
  // If future code needs to pass user input here, that input must be pre-sanitized.
  const bashCommand = `${toShellLine(opts.command, opts.cwd)}; exec bash`;

  const builder = LINUX_BUILDERS[terminal as SupportedTerminal];
  if (builder) {
    const { cmd, args } = builder(bashCommand);
    await spawnDetached(cmd, args);
    return;
  }
  await firstThatSpawns(AUTO_DETECT.map((build) => build(bashCommand)));
}
