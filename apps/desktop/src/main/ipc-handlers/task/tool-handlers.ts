import { ipcMain } from 'electron';
import { existsSync } from 'fs';
import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult, SupportedIDE, SupportedTerminal } from '../../../shared/types';
import { detectInstalledTools } from './tool-detection/detect';
import { openInIDE, openInTerminal } from './tool-detection/launch';
import type { DetectedTools } from './tool-detection/types';

/**
 * Register worktree tool handlers (detect tools, open in IDE, open in terminal)
 */
export function registerWorktreeToolHandlers(): void {
  /**
   * Detect installed IDEs and terminals on the system
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_WORKTREE_DETECT_TOOLS,
    async (): Promise<IPCResult<DetectedTools>> => {
      try {
        const tools = await detectInstalledTools();
        return { success: true, data: tools };
      } catch (error) {
        console.error('Failed to detect tools:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to detect installed tools'
        };
      }
    }
  );

  /**
   * Open a worktree directory in the specified IDE
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_WORKTREE_OPEN_IN_IDE,
    async (_, worktreePath: string, ide: SupportedIDE, customPath?: string): Promise<IPCResult<{ opened: boolean }>> => {
      try {
        if (!existsSync(worktreePath)) {
          return { success: false, error: 'Worktree path does not exist' };
        }

        const result = await openInIDE(worktreePath, ide, customPath);
        if (!result.success) {
          return { success: false, error: result.error };
        }

        return { success: true, data: { opened: true } };
      } catch (error) {
        console.error('Failed to open in IDE:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to open in IDE'
        };
      }
    }
  );

  /**
   * Open a worktree directory in the specified terminal
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_WORKTREE_OPEN_IN_TERMINAL,
    async (_, worktreePath: string, terminal: SupportedTerminal, customPath?: string): Promise<IPCResult<{ opened: boolean }>> => {
      try {
        if (!existsSync(worktreePath)) {
          return { success: false, error: 'Worktree path does not exist' };
        }

        const result = await openInTerminal(worktreePath, terminal, customPath);
        if (!result.success) {
          return { success: false, error: result.error };
        }

        return { success: true, data: { opened: true } };
      } catch (error) {
        console.error('Failed to open in terminal:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to open in terminal'
        };
      }
    }
  );
}
