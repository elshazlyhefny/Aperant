/**
 * zeenha fork: PR reviewers get the project's MCP servers through the same
 * per-agent overrides as task agents (`AGENT_MCP_pr_security_specialist_ADD=github`
 * in `.auto-claude/.env`). Upstream PR review connected no MCP at all, so the
 * reviewers could not read CI job logs or earlier review comments.
 *
 * One session per review: each server is connected once (the four specialists
 * ask in parallel) and every connection is closed when the review ends. A
 * server that fails to start is logged and skipped; the review goes on.
 */
import type { Tool as AITool } from 'ai';

import type { AgentType } from '../../config/agent-configs';
import { connectMcpServers, closeAllMcpClients, mergeMcpTools, resolveMcpServersForAgent } from '../../mcp/client';
import { mcpResolveOptionsForAgent, readApprovedProjectMcpOptions } from '../../mcp/project-settings';
import type { McpApprovals } from '../../mcp/mcp-approval';
import type { McpClientResult } from '../../mcp/types';

export interface PRReviewMcpSession {
  toolsFor(agentType: AgentType): Promise<Record<string, AITool>>;
  close(): Promise<void>;
}

export function createPRReviewMcpSession(
  projectPath: string,
  autoBuildPath = '.auto-claude',
  onLog?: (line: string) => void,
  /** Omitted means nothing declared by the project is approved (fail closed). */
  approvals?: McpApprovals,
): PRReviewMcpSession {
  const settings = readApprovedProjectMcpOptions(projectPath, autoBuildPath, approvals);
  const options = {
    context7Enabled: settings.context7Enabled,
    electronMcpEnabled: settings.electronMcpEnabled,
    chromeDevtoolsMcpEnabled: settings.chromeDevtoolsMcpEnabled,
    agentMcpOverrides: settings.agentMcpOverrides,
  };
  const connecting = new Map<string, Promise<McpClientResult | null>>();
  let closed = false;

  return {
    async toolsFor(agentType) {
      if (closed) return {};
      const configs = resolveMcpServersForAgent(agentType, mcpResolveOptionsForAgent(options, agentType), {
        customServers: settings.customServers,
      });
      const clients = await Promise.all(
        configs.map((config) => {
          let pending = connecting.get(config.id);
          if (!pending) {
            pending = connectMcpServers([config], (id, error) => {
              onLog?.(`MCP server "${id}" failed to start (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
            }).then((connected) => {
              if (connected[0]) onLog?.(`MCP server "${config.id}" connected`);
              return connected[0] ?? null;
            });
            connecting.set(config.id, pending);
          }
          return pending;
        }),
      );
      return mergeMcpTools(clients.filter((c): c is McpClientResult => c !== null)) as Record<string, AITool>;
    },
    async close() {
      closed = true;
      const clients = (await Promise.all(connecting.values())).filter((c): c is McpClientResult => c !== null);
      connecting.clear();
      await closeAllMcpClients(clients);
    },
  };
}
