import path from 'path';
import { existsSync } from 'fs';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { shell } from 'electron';
import type { SupportedIDE, SupportedTerminal } from '../../../../shared/types';
import { getCurrentOS } from '../../../platform';
import { isPathSafe } from './path-safety';
import { launchTerminal } from './terminal-launch';
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

    await launchTerminal({ terminal, cwd: dirPath });
    return { success: true };
  } catch (error) {
    console.error(`Failed to open in terminal ${terminal}:`, error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to open terminal' };
  }
}
