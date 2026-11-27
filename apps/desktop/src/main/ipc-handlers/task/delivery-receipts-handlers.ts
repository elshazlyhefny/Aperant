import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult } from '../../../shared/types';
import type { DeliveryReceipt } from '../../../shared/types/delivery-receipt';
import { readDeliveryReceipts } from '../../delivery-receipts';
import { projectStore } from '../../project-store';
import { isValidTaskId } from '../../utils/spec-path-helpers';

/** zeenha fork: read the same project-root history for desktop and daemon tasks. */
export function registerTaskDeliveryReceiptsHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.TASK_DELIVERY_RECEIPTS_GET,
    async (_, projectId: string, specId: string): Promise<IPCResult<DeliveryReceipt[]>> => {
      if (typeof projectId !== 'string' || !projectId.trim()) {
        return { success: false, error: 'Invalid project ID' };
      }
      if (!isValidTaskId(specId)) {
        return { success: false, error: 'Invalid spec ID' };
      }

      try {
        const project = projectStore.getProject(projectId);
        if (!project) return { success: false, error: 'Project not found' };
        return { success: true, data: await readDeliveryReceipts(project.path, specId) };
      } catch {
        return { success: false, error: 'Delivery receipt history is unreadable.' };
      }
    }
  );
}
