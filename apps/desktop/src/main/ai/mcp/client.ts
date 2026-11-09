/**
 * MCP Client
 * ===========
 *
 * Creates MCP clients using @ai-sdk/mcp with @modelcontextprotocol/sdk
 * for stdio and StreamableHTTP transports.
 *
 * The primary path uses createMCPClient from @ai-sdk/mcp which provides
 * direct AI SDK tool integration. Stdio transport uses StdioClientTransport
 * from @modelcontextprotocol/sdk. HTTP transport uses the built-in SSE
 * transport from @ai-sdk/mcp.
 */

import { createMCPClient } from '@ai-sdk/mcp';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpClientResult, McpServerConfig, StdioTransportConfig, StreamableHttpTransportConfig } from './types';
import { type McpRegistryOptions, resolveMcpServers } from './registry';
import type { AgentType } from '../config/agent-configs';
import { getRequiredMcpServers } from '../config/agent-configs';
import type { McpServerResolveOptions } from '../config/agent-configs';

// =============================================================================
// Transport Creation
// =============================================================================

/**
 * Create the appropriate transport for an MCP server configuration.
 *
 * For stdio servers: creates a StdioClientTransport instance from @modelcontextprotocol/sdk
 * For HTTP servers: returns an SSE transport config object for @ai-sdk/mcp
 *
 * @param config - Server configuration with transport details
 * @returns Transport for createMCPClient
 */
function createTransport(
  config: McpServerConfig,
): StdioClientTransport | { type: 'http'; url: string; headers?: Record<string, string> } {
  const { transport } = config;

  if (transport.type === 'stdio') {
    const stdioConfig = transport as StdioTransportConfig;
    return new StdioClientTransport({
      command: stdioConfig.command,
      args: stdioConfig.args ?? [],
      // Do not spread process.env here: it would hand every developer
      // credential to the MCP server. StdioClientTransport merges this over
      // the SDK's restricted default environment (PATH, HOME, etc.).
      env: stdioConfig.env,
      cwd: stdioConfig.cwd,
    });
  }

  // StreamableHTTP transport. zeenha fork: upstream sent these as 'sse', the
  // older protocol, which a Streamable-HTTP-only server (e.g. a remote /mcp
  // endpoint) refuses.
  const httpConfig = transport as StreamableHttpTransportConfig;
  return {
    type: 'http' as const,
    url: httpConfig.url,
    headers: httpConfig.headers,
  };
}

// =============================================================================
// Client Creation
// =============================================================================

/**
 * Create an MCP client for a single server configuration.
 *
 * Uses createMCPClient from @ai-sdk/mcp which provides tools
 * compatible with the AI SDK streamText/generateText functions.
 *
 * @param config - Server configuration to connect to
 * @returns MCP client result with tools and cleanup function
 */
/** zeenha fork: an MCP server that never answers must not hold an agent's start. */
export const MCP_CONNECT_TIMEOUT_MS = 90_000;

export async function createMcpClient(
  config: McpServerConfig,
  timeoutMs: number = MCP_CONNECT_TIMEOUT_MS,
): Promise<McpClientResult> {
  const transport = createTransport(config);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`MCP server "${config.id}" did not answer within ${timeoutMs / 1000}s`)), timeoutMs);
  });

  let client: Awaited<ReturnType<typeof createMCPClient>> | undefined;
  let tools: Awaited<ReturnType<NonNullable<typeof client>['tools']>>;
  try {
    const connect = (async () => {
      client = await createMCPClient({ transport });
      return client.tools();
    })();
    tools = await Promise.race([connect, timeout]);
  } catch (error) {
    await client?.close().catch(() => undefined);
    if (!client && transport instanceof StdioClientTransport) {
      // A connect that timed out may have spawned the server: stop it.
      try {
        await transport.close?.();
      } catch {
        // best effort
      }
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  return {
    serverId: config.id,
    tools,
    close: async () => {
      await client?.close();
    },
  };
}

/**
 * Create MCP clients for all servers required by an agent type.
 *
 * Resolves which MCP servers the agent needs based on its configuration
 * and the current environment, then creates clients for each.
 *
 * @param agentType - The agent type to get MCP servers for
 * @param resolveOptions - Options for resolving which servers to use
 * @param registryOptions - Options for configuring server connections
 * @returns Array of MCP client results with tools and cleanup functions
 */
export async function createMcpClientsForAgent(
  agentType: AgentType,
  resolveOptions: McpServerResolveOptions = {},
  registryOptions: McpRegistryOptions = {},
  onError?: (serverId: string, error: unknown) => void,
): Promise<McpClientResult[]> {
  const serverConfigs = resolveMcpServersForAgent(agentType, resolveOptions, registryOptions);
  return connectMcpServers(serverConfigs, onError);
}

/**
 * zeenha fork: which server configs an agent type needs. Custom server ids are
 * recognised in per-agent overrides only when their definitions are known.
 */
export function resolveMcpServersForAgent(
  agentType: AgentType,
  resolveOptions: McpServerResolveOptions = {},
  registryOptions: McpRegistryOptions = {},
): McpServerConfig[] {
  const customServerIds = resolveOptions.customServerIds
    ?? registryOptions.customServers?.map((c) => c.id);
  const serverIds = getRequiredMcpServers(agentType, { ...resolveOptions, customServerIds });
  return resolveMcpServers(serverIds, registryOptions);
}

/** Connect to servers in parallel; a failed server is reported, never fatal. */
export async function connectMcpServers(
  serverConfigs: McpServerConfig[],
  onError?: (serverId: string, error: unknown) => void,
): Promise<McpClientResult[]> {
  const results = await Promise.allSettled(
    serverConfigs.map((config) => createMcpClient(config)),
  );

  const clients: McpClientResult[] = [];
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      clients.push(result.value);
    } else {
      // Non-fatal: the agent works without optional MCP tools. Upstream
      // swallowed this silently, so a broken server looked like a quiet one.
      onError?.(serverConfigs[i].id, result.reason);
    }
  });

  return clients;
}

/**
 * Merge tools from multiple MCP clients into a single tools object.
 *
 * @param clients - Array of MCP client results
 * @returns Combined tools object for use with streamText/generateText
 */
export function mergeMcpTools(
  clients: McpClientResult[],
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};

  for (const client of clients) {
    Object.assign(merged, client.tools);
  }

  return merged;
}

/**
 * Close all MCP clients gracefully.
 *
 * @param clients - Array of MCP client results to close
 */
export async function closeAllMcpClients(
  clients: McpClientResult[],
): Promise<void> {
  await Promise.allSettled(clients.map((c) => c.close()));
}
