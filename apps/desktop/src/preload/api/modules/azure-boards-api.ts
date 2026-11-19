import { IPC_CHANNELS } from '../../../shared/constants';
import type {
  AzureBoardsSavedQuery,
  AzureBoardsMetadata,
  AzureBoardsQueryRequest,
  AzureBoardsQueryResult,
  AzureBoardsImportResult,
  IPCResult
} from '../../../shared/types';
import { invokeIpc } from './ipc-utils';

/**
 * Azure Boards Integration API operations
 */
export interface AzureBoardsAPI {
  getAzureBoardsSavedQueries: (projectId: string) => Promise<IPCResult<AzureBoardsSavedQuery[]>>;
  getAzureBoardsMetadata: (projectId: string) => Promise<IPCResult<AzureBoardsMetadata>>;
  queryAzureBoardsWorkItems: (
    projectId: string,
    request: AzureBoardsQueryRequest
  ) => Promise<IPCResult<AzureBoardsQueryResult>>;
  importAzureBoardsWorkItems: (
    projectId: string,
    ids: number[],
    allowDuplicates?: boolean
  ) => Promise<IPCResult<AzureBoardsImportResult>>;
}

/**
 * Creates the Azure Boards Integration API implementation
 */
export const createAzureBoardsAPI = (): AzureBoardsAPI => ({
  getAzureBoardsSavedQueries: (projectId: string): Promise<IPCResult<AzureBoardsSavedQuery[]>> =>
    invokeIpc(IPC_CHANNELS.AZUREBOARDS_GET_SAVED_QUERIES, projectId),

  getAzureBoardsMetadata: (projectId: string): Promise<IPCResult<AzureBoardsMetadata>> =>
    invokeIpc(IPC_CHANNELS.AZUREBOARDS_GET_METADATA, projectId),

  queryAzureBoardsWorkItems: (
    projectId: string,
    request: AzureBoardsQueryRequest
  ): Promise<IPCResult<AzureBoardsQueryResult>> =>
    invokeIpc(IPC_CHANNELS.AZUREBOARDS_QUERY_WORK_ITEMS, projectId, request),

  importAzureBoardsWorkItems: (
    projectId: string,
    ids: number[],
    allowDuplicates?: boolean
  ): Promise<IPCResult<AzureBoardsImportResult>> =>
    invokeIpc(IPC_CHANNELS.AZUREBOARDS_IMPORT_WORK_ITEMS, projectId, ids, allowDuplicates)
});
