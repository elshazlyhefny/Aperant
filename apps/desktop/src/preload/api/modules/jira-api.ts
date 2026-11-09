import { IPC_CHANNELS } from '../../../shared/constants';
import type {
  JiraProject,
  JiraIssuePage,
  JiraImportResult,
  JiraSyncStatus,
  IPCResult
} from '../../../shared/types';
import { invokeIpc } from './ipc-utils';

/**
 * Jira Integration API operations
 */
export interface JiraAPI {
  checkJiraConnection: (projectId: string) => Promise<IPCResult<JiraSyncStatus>>;
  getJiraProjects: (projectId: string) => Promise<IPCResult<JiraProject[]>>;
  getJiraIssues: (
    projectId: string,
    options?: { projectKey?: string; searchText?: string; nextPageToken?: string }
  ) => Promise<IPCResult<JiraIssuePage>>;
  importJiraIssues: (
    projectId: string,
    issueKeys: string[],
    allowDuplicates?: boolean
  ) => Promise<IPCResult<JiraImportResult>>;
}

/**
 * Creates the Jira Integration API implementation
 */
export const createJiraAPI = (): JiraAPI => ({
  checkJiraConnection: (projectId: string): Promise<IPCResult<JiraSyncStatus>> =>
    invokeIpc(IPC_CHANNELS.JIRA_CHECK_CONNECTION, projectId),

  getJiraProjects: (projectId: string): Promise<IPCResult<JiraProject[]>> =>
    invokeIpc(IPC_CHANNELS.JIRA_GET_PROJECTS, projectId),

  getJiraIssues: (
    projectId: string,
    options?: { projectKey?: string; searchText?: string; nextPageToken?: string }
  ): Promise<IPCResult<JiraIssuePage>> =>
    invokeIpc(IPC_CHANNELS.JIRA_GET_ISSUES, projectId, options),

  importJiraIssues: (
    projectId: string,
    issueKeys: string[],
    allowDuplicates?: boolean
  ): Promise<IPCResult<JiraImportResult>> =>
    invokeIpc(IPC_CHANNELS.JIRA_IMPORT_ISSUES, projectId, issueKeys, allowDuplicates)
});
