import path from 'path';
import { existsSync } from 'fs';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { shell } from 'electron';
import type { SupportedIDE, SupportedTerminal } from '../../../../shared/types';
import { getCurrentOS } from '../../../platform';
import { escapeSingleQuotedPath, isPathSafe } from './path-safety';
import { IDE_DETECTION, TERMINAL_DETECTION } from './tables';

const execFileAsync = promisify(execFile);


/**
 * Open a directory in the specified IDE
 */
export async function openInIDE(dirPath: string, ide: SupportedIDE, customPath?: string): Promise<{ success: boolean; error?: string }> {
  const platform = getCurrentOS() as 'darwin' | 'win32' | 'linux';

  try {
    if (ide === 'custom' && customPath) {
      // Use custom IDE path with execFileAsync to prevent shell injection
      // Validate the custom path is a valid executable path
      if (!isPathSafe(customPath)) {
        return { success: false, error: 'Invalid custom IDE path' };
      }
      await execFileAsync(customPath, [dirPath]);
      return { success: true };
    }

    const config = IDE_DETECTION[ide];
    if (!config) {
      return { success: false, error: `Unknown IDE: ${ide}` };
    }

    const command = config.commands[platform];
    if (!command) {
      return { success: false, error: `IDE ${ide} is not supported on ${platform}` };
    }

    // Special handling for macOS .app bundles
    if (platform === 'darwin') {
      const appPath = config.paths.darwin?.[0];
      if (appPath && existsSync(appPath)) {
        // Use 'open' command with execFileAsync to prevent shell injection
        await execFileAsync('open', ['-a', path.basename(appPath, '.app'), dirPath]);
        return { success: true };
      }
    }

    // Special handling for Windows batch files (.cmd, .bat)
    // execFile doesn't search PATH, so we need shell: true for batch files
    if (platform === 'win32' && (command.endsWith('.cmd') || command.endsWith('.bat'))) {
      return new Promise((resolve) => {
        const child = spawn(command, [dirPath], {
          shell: true,
          detached: true,
          stdio: 'ignore'
        });
        child.unref();
        resolve({ success: true });
      });
    }

    // Use command line tool with execFileAsync
    await execFileAsync(command, [dirPath]);
    return { success: true };
  } catch (error) {
    console.error(`Failed to open in IDE ${ide}:`, error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to open IDE' };
  }
}

/**
 * Open a directory in the specified terminal
 */
export async function openInTerminal(dirPath: string, terminal: SupportedTerminal, customPath?: string): Promise<{ success: boolean; error?: string }> {
  const platform = getCurrentOS() as 'darwin' | 'win32' | 'linux';

  try {
    if (terminal === 'custom' && customPath) {
      // Use custom terminal path with execFileAsync to prevent shell injection
      if (!isPathSafe(customPath)) {
        return { success: false, error: 'Invalid custom terminal path' };
      }
      await execFileAsync(customPath, [dirPath]);
      return { success: true };
    }

    const config = TERMINAL_DETECTION[terminal];
    if (!config) {
      return { success: false, error: `Unknown terminal: ${terminal}` };
    }

    const commands = config.commands[platform];
    if (!commands || commands.length === 0) {
      // Fall back to opening the folder in system file manager
      await shell.openPath(dirPath);
      return { success: true };
    }

    if (platform === 'darwin') {
      // macOS: Use open command with the directory
      // Escape single quotes in dirPath to prevent script injection
      const escapedPath = escapeSingleQuotedPath(dirPath);

      if (terminal === 'system') {
        // Use AppleScript to open Terminal.app at the directory
        const script = `tell application "Terminal" to do script "cd '${escapedPath}'"`;
        await execFileAsync('osascript', ['-e', script]);
      } else if (terminal === 'iterm2') {
        // Use AppleScript to open iTerm2 at the directory
        const script = `tell application "iTerm"
          create window with default profile
          tell current session of current window
            write text "cd '${escapedPath}'"
          end tell
        end tell`;
        await execFileAsync('osascript', ['-e', script]);
      } else if (terminal === 'warp') {
        // Warp can be opened with just the directory using execFileAsync
        await execFileAsync('open', ['-a', 'Warp', dirPath]);
      } else {
        // For other terminals, use execFileAsync with arguments array
        await execFileAsync(commands[0], [...commands.slice(1), dirPath]);
      }
    } else if (platform === 'win32') {
      // Windows: Start terminal at directory using spawn to avoid shell injection
      if (terminal === 'system') {
        // Use spawn with proper argument separation
        spawn('cmd.exe', ['/K', 'cd', '/d', dirPath], { detached: true, stdio: 'ignore' }).unref();
      } else if (commands.length > 0) {
        spawn(commands[0], [...commands.slice(1), dirPath], { detached: true, stdio: 'ignore' }).unref();
      }
    } else {
      // Linux: Use the configured terminal with execFileAsync
      if (terminal === 'system') {
        // Try common terminal emulators with proper argument arrays
        try {
          await execFileAsync('x-terminal-emulator', ['--working-directory', dirPath, '-e', 'bash']);
        } catch {
          try {
            await execFileAsync('gnome-terminal', ['--working-directory', dirPath]);
          } catch {
            // xterm doesn't have --working-directory, use -e with a script
            // Escape the path for shell use within the xterm command
            const escapedPath = escapeSingleQuotedPath(dirPath);
            await execFileAsync('xterm', ['-e', `cd '${escapedPath}' && bash`]);
          }
        }
      } else {
        // Use execFileAsync with arguments array
        await execFileAsync(commands[0], [...commands.slice(1), dirPath]);
      }
    }

    return { success: true };
  } catch (error) {
    console.error(`Failed to open in terminal ${terminal}:`, error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to open terminal' };
  }
}
