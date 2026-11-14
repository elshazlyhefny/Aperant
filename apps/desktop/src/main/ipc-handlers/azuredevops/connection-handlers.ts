/**
 * Azure DevOps connection and repository detection handlers
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../../shared/constants';
import type {
  IPCResult,
  AzureDevOpsSyncStatus,
  AzureDevOpsDetectedRepository
} from '../../../shared/types';
import { projectStore } from '../../project-store';
import {
  getAzureDevOpsConfig,
  azureDevOpsFetch,
  detectAzureDevOpsRepositoryFromRemote
} from './utils';
import { createDebugLog } from '../../../shared/utils/debug-logger';

const debugLog = createDebugLog('AzureDevOps Connection');

const NOT_CONFIGURED = 'Azure DevOps not configured';

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function registerCheckConnection(): void {
  ipcMain.handle(
    IPC_CHANNELS.AZUREDEVOPS_CHECK_CONNECTION,
    async (_event, projectId: string): Promise<IPCResult<AzureDevOpsSyncStatus>> => {
      debugLog('checkAzureDevOpsConnection handler called');
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };

      const config = await getAzureDevOpsConfig(project);
      if (!config) return { success: false, error: NOT_CONFIGURED };

      const fullName = `${config.organization}/${config.project}/${config.repository}`;
      try {
        await azureDevOpsFetch(config, `/git/repositories/${encodeURIComponent(config.repository)}`);
        return { success: true, data: { connected: true, repoFullName: fullName } };
      } catch (error) {
        debugLog('Connection check failed:', errorMessage(error, 'unknown'));
        return {
          success: true,
          data: {
            connected: false,
            repoFullName: fullName,
            error: errorMessage(error, 'Failed to connect to Azure DevOps')
          }
        };
      }
    }
  );
}

export function registerDetectRepository(): void {
  ipcMain.handle(
    IPC_CHANNELS.AZUREDEVOPS_DETECT_REPOSITORY,
    async (_event, projectId: string): Promise<IPCResult<AzureDevOpsDetectedRepository | null>> => {
      debugLog('detectAzureDevOpsRepository handler called');
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };

      return { success: true, data: detectAzureDevOpsRepositoryFromRemote(project.path) };
    }
  );
}
