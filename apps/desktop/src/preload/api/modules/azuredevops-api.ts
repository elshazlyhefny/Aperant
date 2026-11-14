// zeenha fork: Azure DevOps preload bridge, not present upstream.
import { IPC_CHANNELS } from '../../../shared/constants';
import type {
  AzureDevOpsSyncStatus,
  AzureDevOpsDetectedRepository,
  IPCResult
} from '../../../shared/types';
import { invokeIpc } from './ipc-utils';

/**
 * Azure DevOps Integration API operations
 */
export interface AzureDevOpsAPI {
  checkAzureDevOpsConnection: (projectId: string) => Promise<IPCResult<AzureDevOpsSyncStatus>>;
  detectAzureDevOpsRepository: (projectId: string) => Promise<IPCResult<AzureDevOpsDetectedRepository | null>>;
}

/**
 * Creates the Azure DevOps Integration API implementation
 */
export const createAzureDevOpsAPI = (): AzureDevOpsAPI => ({
  checkAzureDevOpsConnection: (projectId: string): Promise<IPCResult<AzureDevOpsSyncStatus>> =>
    invokeIpc(IPC_CHANNELS.AZUREDEVOPS_CHECK_CONNECTION, projectId),

  detectAzureDevOpsRepository: (projectId: string): Promise<IPCResult<AzureDevOpsDetectedRepository | null>> =>
    invokeIpc(IPC_CHANNELS.AZUREDEVOPS_DETECT_REPOSITORY, projectId)
});
