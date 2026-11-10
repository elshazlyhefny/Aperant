/**
 * Sandbox IPC handlers.
 *
 * zeenha fork: reports whether the OS-level Bash sandbox can run here.
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult } from '../../shared/types';
import type { SandboxAvailability } from '../../shared/types/project';
import { getSandboxAvailability } from '../ai/security/sandbox-status';

export function registerSandboxHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.SANDBOX_GET_AVAILABILITY,
    async (): Promise<IPCResult<SandboxAvailability>> => {
      try {
        return { success: true, data: getSandboxAvailability() };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to detect sandbox availability'
        };
      }
    }
  );
}
