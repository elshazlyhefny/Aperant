/**
 * Tool Registry
 * =============
 *
 * See apps/desktop/src/main/ai/tools/registry.ts for the TypeScript implementation.
 *
 * Single source of truth for tool name constants, agent-to-tool mappings,
 * and the ToolRegistry class that resolves tools for a given agent type.
 */

import type { Tool as AITool } from 'ai';

import {
  type AgentConfig,
  type AgentType,
  AGENT_CONFIGS,
  CONTEXT7_TOOLS,
  ELECTRON_TOOLS,
  MEMORY_MCP_TOOLS,
  GRAPHITI_MCP_TOOLS,
  getAgentConfig,
  getDefaultThinkingLevel,
  mapMcpServerName,
} from '../config/agent-configs';
import { webToolsBlockedBySandbox } from '../security/sandbox';
import type { DefinedTool } from './define';
import type { ToolContext } from './types';

export {
  type AgentConfig,
  type AgentType,
  AGENT_CONFIGS,
  CONTEXT7_TOOLS,
  ELECTRON_TOOLS,
  MEMORY_MCP_TOOLS,
  GRAPHITI_MCP_TOOLS,
  getAgentConfig,
  getDefaultThinkingLevel,
};

// Re-export tool name constants that were previously defined here
export const BASE_READ_TOOLS = ['Read', 'Glob', 'Grep'] as const;
export const BASE_WRITE_TOOLS = ['Write', 'Edit', 'Bash'] as const;
export const WEB_TOOLS = ['WebFetch', 'WebSearch'] as const;

// =============================================================================
// MCP Config for dynamic server resolution
// =============================================================================

export interface McpConfig {
  CONTEXT7_ENABLED?: string;
  ELECTRON_MCP_ENABLED?: string;
  CHROME_DEVTOOLS_MCP_ENABLED?: string;
  CUSTOM_MCP_SERVERS?: Array<{ id: string }>;
  [key: string]: unknown;
}

export interface ProjectCapabilities {
  is_electron?: boolean;
  is_web_frontend?: boolean;
}

// =============================================================================
// ToolRegistry
// =============================================================================

/**
 * Registry for AI tools.
 *
 * Manages tool registration and provides agent-type-aware tool resolution
 * using the AGENT_CONFIGS mapping ported from Python.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, DefinedTool>();

  /**
   * Register a tool by name.
   */
  registerTool(name: string, definedTool: DefinedTool): void {
    this.tools.set(name, definedTool);
  }

  /**
   * Get a registered tool by name, or undefined if not found.
   */
  getTool(name: string): DefinedTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all registered tool names.
   */
  getRegisteredNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Get the AI SDK tool map for a given agent type, bound to the provided context.
   *
   * Filters registered tools to only those allowed by AGENT_CONFIGS for the
   * specified agent type. Returns a Record<string, AITool> suitable for passing
   * to the Vercel AI SDK `generateText` / `streamText` calls.
   */
  getToolsForAgent(
    agentType: AgentType,
    context: ToolContext,
  ): Record<string, AITool> {
    const config = getAgentConfig(agentType);
    const allowedNames = new Set(config.tools);
    const result: Record<string, AITool> = {};
    // zeenha fork: the Bash sandbox's --unshare-net / (deny network*) only wraps Bash,
    // so the in-process web tools would be a network path around a no-network sandbox.
    // 'restricted-rights' (Windows) does not block network and is intentionally unaffected.
    const skipWebTools = webToolsBlockedBySandbox(context.securityProfile);
    const webToolNames: readonly string[] = WEB_TOOLS;

    for (const [name, definedTool] of Array.from(this.tools.entries())) {
      if (skipWebTools && webToolNames.includes(name)) continue;
      if (allowedNames.has(name)) {
        result[name] = definedTool.bind(context);
      }
    }

    return result;
  }
}

/**
 * Get MCP servers required for an agent type.
 *
 * Handles dynamic server selection:
 * - "browser" → electron (if is_electron) or chrome-devtools (if enabled)
 * - "memory" → only if memoryEnabled is true
 * - Applies per-agent ADD/REMOVE overrides from mcpConfig
 */
export function getRequiredMcpServers(
  agentType: AgentType,
  options: {
    projectCapabilities?: ProjectCapabilities;
    memoryEnabled?: boolean;
    /** @deprecated Use memoryEnabled instead */
    graphitiEnabled?: boolean;
    mcpConfig?: McpConfig;
  } = {},
): string[] {
  const {
    projectCapabilities,
    memoryEnabled = options.graphitiEnabled ?? false,
    mcpConfig = {},
  } = options;

  const config = getAgentConfig(agentType);
  let servers = [...config.mcpServers];

  // Filter context7 if explicitly disabled
  if (servers.includes('context7')) {
    const enabled = mcpConfig.CONTEXT7_ENABLED ?? 'true';
    if (String(enabled).toLowerCase() === 'false') {
      servers = servers.filter((s) => s !== 'context7');
    }
  }

  // Handle dynamic "browser" → electron/chrome-devtools
  if (servers.includes('browser')) {
    servers = servers.filter((s) => s !== 'browser');
    const electronEnabled = mcpConfig.ELECTRON_MCP_ENABLED ?? 'false';
    const chromeEnabled = mcpConfig.CHROME_DEVTOOLS_MCP_ENABLED ?? 'false';
    if (projectCapabilities?.is_electron && String(electronEnabled).toLowerCase() === 'true') {
      servers.push('electron');
    } else if (String(chromeEnabled).toLowerCase() === 'true') {
      servers.push('chrome-devtools');
    }
  }

  // Filter memory if not enabled
  if (servers.includes('memory') && !memoryEnabled) {
    servers = servers.filter((s) => s !== 'memory');
  }

  // Per-agent MCP overrides: AGENT_MCP_<agent>_ADD / AGENT_MCP_<agent>_REMOVE
  const customServerIds =
    mcpConfig.CUSTOM_MCP_SERVERS?.map((s) => s.id).filter(Boolean) ?? [];

  const addKey = `AGENT_MCP_${agentType}_ADD`;
  const addValue = mcpConfig[addKey];
  if (typeof addValue === 'string') {
    const additions = addValue.split(',').map((s) => s.trim()).filter(Boolean);
    for (const server of additions) {
      const mapped = mapMcpServerName(server, customServerIds);
      if (mapped && !servers.includes(mapped)) {
        servers.push(mapped);
      }
    }
  }

  const removeKey = `AGENT_MCP_${agentType}_REMOVE`;
  const removeValue = mcpConfig[removeKey];
  if (typeof removeValue === 'string') {
    const removals = removeValue.split(',').map((s) => s.trim()).filter(Boolean);
    for (const server of removals) {
      const mapped = mapMcpServerName(server, customServerIds);
      if (mapped) {
        servers = servers.filter((s) => s !== mapped);
      }
    }
  }

  return servers;
}
