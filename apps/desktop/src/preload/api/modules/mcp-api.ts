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
  /** Approve the project-declared webhook URL; `hash` is the one the page showed */
  approveProjectWebhook: (projectId: string, expectedHash: string) => Promise<IPCResult>;
  /** Generate or rotate the secret for the currently approved destination, revealing it once. */
  generateProjectWebhookSecret: (projectId: string, expectedHash: string) => Promise<IPCResult<{ secret: string; createdAt: string }>>;
  setProjectWebhookUnsigned: (projectId: string, expectedHash: string) => Promise<IPCResult>;
  sendProjectTestWebhook: (projectId: string, expectedHash: string, format?: string) => Promise<IPCResult<{ success: boolean }>>;
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
    approveProjectWebhook: (projectId: string, expectedHash: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.WEBHOOK_APPROVE_PROJECT, projectId, expectedHash),
    generateProjectWebhookSecret: (projectId: string, expectedHash: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.WEBHOOK_PROJECT_SECRET_GENERATE, projectId, expectedHash),
    setProjectWebhookUnsigned: (projectId: string, expectedHash: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.WEBHOOK_PROJECT_SIGNING_UNSIGNED, projectId, expectedHash),
    sendProjectTestWebhook: (projectId: string, expectedHash: string, format?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.WEBHOOK_PROJECT_SEND_TEST, projectId, expectedHash, format),
  };
}
