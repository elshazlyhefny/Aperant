import type { SupportedTerminal } from '../../../../../shared/types';
import { escapeAppleScriptString } from '../path-safety';
import { TERMINAL_DETECTION } from '../tables';
import { runAppleScript, runFile, spawnDetached, toShellLine, withDirArg } from './spawn';
import type { LaunchOptions, Launcher } from './types';

/**
 * Terminal.app. IMPORTANT: do script FIRST, then activate - this prevents opening a blank
 * default window when Terminal.app isn't already running.
 */
const terminalApp: Launcher = ({ command, cwd }) => {
  const line = escapeAppleScriptString(toShellLine(command, cwd));
  return runAppleScript(`
        tell application "Terminal"
          do script "${line}"
          activate
        end tell
      `);
};

/** iTerm2 - handle both running and not-running cases to prevent double windows. */
const iterm2: Launcher = ({ command, cwd }) => {
  const line = escapeAppleScriptString(toShellLine(command, cwd));
  return runAppleScript(`
        if application "iTerm" is running then
          tell application "iTerm"
            create window with default profile
            tell current session of current window
              write text "${line}"
            end tell
            activate
          end tell
        else
          tell application "iTerm"
            activate
          end tell
          delay 0.5
          tell application "iTerm"
            tell current session of current window
              write text "${line}"
            end tell
          end tell
        end if
      `);
};

/** Open a terminal app at a directory (no command) using the TERMINAL_DETECTION `open -a` entry. */
const openAtDirectory = (terminal: string, cwd?: string): Promise<void> => {
  const commands = TERMINAL_DETECTION[terminal as SupportedTerminal]?.commands.darwin;
  if (!commands || commands.length === 0) return terminalApp({ terminal, cwd });
  const { cmd, args } = withDirArg(commands, cwd);
  return runFile(cmd, args);
};

/** Launcher for apps without a scriptable command line: activate, then type the command. */
const keystrokeLauncher = (app: string, delaySeconds: number): Launcher => (opts) => {
  const { command, cwd, terminal } = opts;
  if (!command) return openAtDirectory(String(terminal).toLowerCase(), cwd);
  const line = escapeAppleScriptString(toShellLine(command, cwd));
  return runAppleScript(`
        tell application "${app}"
          activate
        end tell
        delay ${delaySeconds}
        tell application "System Events"
          keystroke "${line}"
          keystroke return
        end tell
      `);
};

/** Launcher for apps with a command line: run the shell line, or just open at cwd. */
const commandLauncher = (build: (line: string) => { cmd: string; args: string[] }): Launcher => (opts) => {
  const { command, cwd, terminal } = opts;
  if (!command) return openAtDirectory(String(terminal).toLowerCase(), cwd);
  const { cmd, args } = build(toShellLine(command, cwd));
  return spawnDetached(cmd, args);
};

const openApp = (app: string, extraArgs: string[]) =>
  commandLauncher((line) => ({ cmd: 'open', args: ['-a', app, '--args', ...extraArgs, 'bash', '-c', line] }));

const DARWIN_LAUNCHERS: Partial<Record<SupportedTerminal, Launcher>> = {
  iterm2,
  warp: keystrokeLauncher('Warp', 0.5),
  kitty: commandLauncher((line) => ({ cmd: 'kitty', args: ['--', 'bash', '-c', line] })),
  alacritty: openApp('Alacritty', ['-e']),
  wezterm: commandLauncher((line) => ({ cmd: 'wezterm', args: ['start', '--', 'bash', '-c', line] })),
  ghostty: keystrokeLauncher('Ghostty', 0.3),
  hyper: keystrokeLauncher('Hyper', 0.3),
  tabby: keystrokeLauncher('Tabby', 0.3),
  rio: openApp('Rio', ['-e']),
  contour: openApp('Contour', []),
};

export const launchDarwin = (opts: LaunchOptions): Promise<void> => {
  const terminal = (opts.terminal ? String(opts.terminal) : 'terminal').toLowerCase();
  const launcher = DARWIN_LAUNCHERS[terminal as SupportedTerminal] ?? terminalApp;
  return launcher({ ...opts, terminal });
};
