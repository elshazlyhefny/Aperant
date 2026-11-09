/**
 * MCP Server API
 *
 * Exposes MCP health check and connection test functionality to the renderer.
 */

import { ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../../../shared/constants/ipc';
import type { IPCResult } from '../../../shared/types/common';
import type { CustomMcpServer, McpHealthCheckResult, McpTestConnectionResult } from '../../../shared/types/project';

export interface McpAPI {
  /** Quick health check for a custom MCP server */
  checkMcpHealth: (server: CustomMcpServer, projectId?: string) => Promise<IPCResult<McpHealthCheckResult>>;
  /** Full MCP connection test */
  testMcpConnection: (server: CustomMcpServer, projectId?: string) => Promise<IPCResult<McpTestConnectionResult>>;
  /** Approve a project-declared custom server; `hash` is the one the page showed */
  approveMcpServer: (projectId: string, serverId: string, hash: string) => Promise<IPCResult>;
  /** Approve the project's CHROME_DEVTOOLS_EXECUTABLE; `exePath` is the one the page showed */
  approveChromeExecutable: (projectId: string, exePath: string) => Promise<IPCResult>;
}

export function createMcpAPI(): McpAPI {
  return {
    checkMcpHealth: (server: CustomMcpServer, projectId?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.MCP_CHECK_HEALTH, server, projectId),

    testMcpConnection: (server: CustomMcpServer, projectId?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.MCP_TEST_CONNECTION, server, projectId),

    approveMcpServer: (projectId: string, serverId: string, hash: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.MCP_APPROVE_SERVER, projectId, serverId, hash),

    approveChromeExecutable: (projectId: string, exePath: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.MCP_APPROVE_CHROME_EXECUTABLE, projectId, exePath),
  };
}
