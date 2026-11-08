/**
 * MCP Server Health Check Handlers
 *
 * Handles IPC requests for checking MCP server health and connectivity.
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants/ipc';
import type { CustomMcpServer, McpHealthCheckResult, McpHealthStatus, McpTestConnectionResult } from '../../shared/types/project';
import { spawn } from 'child_process';
import { appLog } from '../app-logger';
import { isWindows } from '../platform';
import { getWhereExePath } from '../utils/windows-paths';
import { projectStore } from '../project-store';
import { readProjectMcpOptions } from '../ai/mcp/project-settings';
import { checkMcpCommand } from '../ai/mcp/command-policy';
import { createMcpClient } from '../ai/mcp/client';
import { customServerToConfig } from '../ai/mcp/registry';

const VAR_REF = /\$\{[A-Z][A-Z0-9_]*\}/;

/**
 * zeenha fork: a saved custom server may write `${NAME}` in its args or headers
 * (expanded from the project's .env when an agent starts). Check the server the
 * way an agent would see it, or "Test" would send the literal placeholder.
 * Returns null when it references a variable the project does not define.
 */
export function resolveForCheck(server: CustomMcpServer, projectId?: string): CustomMcpServer | null {
  const usesVars =
    (server.args ?? []).some((a) => VAR_REF.test(a)) ||
    Object.values(server.headers ?? {}).some((v) => VAR_REF.test(String(v)));
  if (!usesVars) return server;
  const project = projectId ? projectStore.getProjects().find((p) => p.id === projectId) : undefined;
  if (!project) return null;
  // Deliberately the declared (unapproved) view: Test is an explicit user action.
  const expanded = readProjectMcpOptions(project.path, project.autoBuildPath || '.auto-claude')
    .customServers?.find((s) => s.id === server.id);
  return expanded ? { ...server, args: expanded.args, headers: expanded.headers } : null;
}

const MISSING_VARIABLE_MESSAGE =
  'This server references a variable that is not set in the project settings (.auto-claude/.env).';

/**
 * Quick health check for a custom MCP server.
 * For HTTP servers: makes a HEAD/GET request to check connectivity.
 * For command servers: checks if the command exists.
 */
export async function checkMcpHealth(server: CustomMcpServer): Promise<McpHealthCheckResult> {
  const startTime = Date.now();

  if (server.type === 'http') {
    return checkHttpHealth(server, startTime);
  } else {
    return checkCommandHealth(server, startTime);
  }
}

/**
 * Check HTTP server health by making a request.
 */
async function checkHttpHealth(server: CustomMcpServer, startTime: number): Promise<McpHealthCheckResult> {
  if (!server.url) {
    return {
      serverId: server.id,
      status: 'unhealthy',
      message: 'No URL configured',
      checkedAt: new Date().toISOString(),
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10 second timeout

    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };

    // Add custom headers if configured
    if (server.headers) {
      Object.assign(headers, server.headers);
    }

    const response = await fetch(server.url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const responseTime = Date.now() - startTime;

    let status: McpHealthStatus;
    let message: string;

    if (response.ok) {
      status = 'healthy';
      message = 'Server is responding';
    } else if (response.status === 405) {
      // zeenha fork: a Streamable HTTP MCP endpoint may refuse GET (it offers
      // no server-initiated stream) and still serve POST; GitHub's does. It is
      // reachable; "Test" runs the real handshake.
      status = 'healthy';
      message = 'Server is reachable (MCP endpoint)';
    } else if (response.status === 401 || response.status === 403) {
      status = 'needs_auth';
      message = response.status === 401 ? 'Authentication required' : 'Access forbidden';
    } else {
      status = 'unhealthy';
      message = `HTTP ${response.status}: ${response.statusText}`;
    }

    return {
      serverId: server.id,
      status,
      statusCode: response.status,
      message,
      responseTime,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Check for specific error types
    const status: McpHealthStatus = 'unhealthy';
    let message = errorMessage;

    if (errorMessage.includes('abort') || errorMessage.includes('timeout')) {
      message = 'Connection timed out';
    } else if (errorMessage.includes('ECONNREFUSED')) {
      message = 'Connection refused - server may be down';
    } else if (errorMessage.includes('ENOTFOUND')) {
      message = 'Server not found - check URL';
    }

    return {
      serverId: server.id,
      status,
      message,
      responseTime,
      checkedAt: new Date().toISOString(),
    };
  }
}

/**
 * Check command-based server health by verifying the command exists.
 */
async function checkCommandHealth(server: CustomMcpServer, startTime: number): Promise<McpHealthCheckResult> {
  if (!server.command) {
    return {
      serverId: server.id,
      status: 'unhealthy',
      message: 'No command configured',
      checkedAt: new Date().toISOString(),
    };
  }

  return new Promise((resolve) => {
    // Defense-in-depth: Validate command and args before spawn
    const verdict = checkMcpCommand(server.command, server.args);
    if (!verdict.ok) {
      return resolve({
        serverId: server.id,
        status: 'unhealthy',
        message: verdict.reason,
        checkedAt: new Date().toISOString(),
      });
    }

    const command = isWindows() ? getWhereExePath() : 'which';
    const proc = spawn(command, [server.command!], {
      timeout: 5000,
      windowsHide: true,
    });

    let found = false;

    proc.on('close', (code) => {
      const responseTime = Date.now() - startTime;

      if (code === 0 || found) {
        resolve({
          serverId: server.id,
          status: 'healthy',
          message: `Command '${server.command}' found`,
          responseTime,
          checkedAt: new Date().toISOString(),
        });
      } else {
        resolve({
          serverId: server.id,
          status: 'unhealthy',
          message: `Command '${server.command}' not found in PATH`,
          responseTime,
          checkedAt: new Date().toISOString(),
        });
      }
    });

    proc.stdout.on('data', () => {
      found = true;
    });

    proc.on('error', (error: Error) => {
      const responseTime = Date.now() - startTime;
      const errCode = (error as NodeJS.ErrnoException).code;
      let message = `Failed to check command '${server.command}'`;

      // Provide actionable error messages for common failures
      if (errCode === 'ENOENT') {
        message = isWindows()
          ? `System utility 'where.exe' not found. Check Windows installation.`
          : `System utility 'which' not found. Check system PATH configuration.`;
      } else if (errCode === 'EACCES') {
        message = `Permission denied checking command '${server.command}'`;
      }

      resolve({
        serverId: server.id,
        status: 'unhealthy',
        message,
        responseTime,
        checkedAt: new Date().toISOString(),
      });
    });
  });
}

/**
 * Full MCP connection test - actually connects to the server and tries to list tools.
 * This is more thorough but slower than the health check.
 */
export async function testMcpConnection(server: CustomMcpServer): Promise<McpTestConnectionResult> {
  const startTime = Date.now();

  return testWithAgentClient(server, startTime);
}

/**
 * zeenha fork: Test runs the SAME MCP client agents use (ai/mcp/client.ts):
 * connect, initialize, list tools, close. Upstream hand-rolled the protocol,
 * sent `Accept: application/json` only and parsed the reply as plain JSON, so
 * a Streamable HTTP server that answers as an event stream (GitHub's remote
 * MCP) failed with "Server returned error" while agents connected fine.
 */
async function testWithAgentClient(server: CustomMcpServer, startTime: number): Promise<McpTestConnectionResult> {
  if (server.type === 'command') {
    const verdict = checkMcpCommand(server.command, server.args);
    if (!verdict.ok) return { serverId: server.id, success: false, message: verdict.reason };
  } else if (!server.url) {
    return { serverId: server.id, success: false, message: 'No URL configured' };
  }

  const config = customServerToConfig(server);
  if (!config) return { serverId: server.id, success: false, message: 'Server is not configured' };

  try {
    const client = await createMcpClient(config, 30_000);
    const tools = Object.keys(client.tools).sort();
    await client.close().catch(() => undefined);
    return {
      serverId: server.id,
      success: true,
      message: tools.length > 0 ? `Connected successfully, ${tools.length} tools available` : 'Connected successfully',
      tools,
      responseTime: Date.now() - startTime,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    let message = 'Connection failed';
    if (/\b(401|403)\b|unauthori[sz]ed|forbidden/i.test(errorMessage)) message = 'Authentication failed';
    else if (/did not answer|timed? ?out|abort/i.test(errorMessage)) message = 'Connection timed out';
    else if (errorMessage.includes('ECONNREFUSED')) message = 'Connection refused - server may be down';
    else if (errorMessage.includes('ENOTFOUND')) message = 'Server not found - check URL';
    else if (errorMessage.includes('ENOENT')) message = 'Command not found';
    return { serverId: server.id, success: false, message, error: errorMessage, responseTime: Date.now() - startTime };
  }
}

/**
 * Register MCP IPC handlers.
 */
export function registerMcpHandlers(): void {
  // Quick health check
  ipcMain.handle(IPC_CHANNELS.MCP_CHECK_HEALTH, async (_event, rawServer: CustomMcpServer, projectId?: string) => {
    try {
      const server = resolveForCheck(rawServer, projectId);
      if (!server) {
        const data: McpHealthCheckResult = {
          serverId: rawServer.id,
          status: 'unhealthy',
          message: MISSING_VARIABLE_MESSAGE,
          checkedAt: new Date().toISOString(),
        };
        return { success: true, data };
      }
      const result = await checkMcpHealth(server);
      return { success: true, data: result };
    } catch (error) {
      appLog.error('MCP health check error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Health check failed',
      };
    }
  });

  // Full connection test
  ipcMain.handle(IPC_CHANNELS.MCP_TEST_CONNECTION, async (_event, rawServer: CustomMcpServer, projectId?: string) => {
    try {
      const server = resolveForCheck(rawServer, projectId);
      if (!server) {
        const data: McpTestConnectionResult = {
          serverId: rawServer.id,
          success: false,
          message: MISSING_VARIABLE_MESSAGE,
        };
        return { success: true, data };
      }
      const result = await testMcpConnection(server);
      return { success: true, data: result };
    } catch (error) {
      appLog.error('MCP connection test error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Connection test failed',
      };
    }
  });
}
