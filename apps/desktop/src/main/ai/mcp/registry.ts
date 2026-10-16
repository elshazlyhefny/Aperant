/**
 * MCP Server Registry
 * ====================
 *
 * Defines MCP server configurations for all supported integrations.
 * See apps/desktop/src/main/ai/mcp/registry.ts for the TypeScript implementation.
 *
 * Each server config defines how to connect (stdio or StreamableHTTP),
 * and whether it's enabled by default.
 */

import type { CustomMcpServerDefinition, McpServerConfig, McpServerId } from './types';

// =============================================================================
// Server Configuration Definitions
// =============================================================================

/**
 * Context7 MCP server - documentation lookup.
 * Always enabled by default. Uses npx to launch.
 */
const CONTEXT7_SERVER: McpServerConfig = {
  id: 'context7',
  name: 'Context7',
  description: 'Documentation lookup for libraries and frameworks',
  enabledByDefault: true,
  transport: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp@latest'],
  },
};

/**
 * Memory MCP server - knowledge graph memory.
 * Conditionally enabled when GRAPHITI_MCP_URL is set.
 * Connects via StreamableHTTP to the running memory sidecar.
 */
function createMemoryServer(url: string): McpServerConfig {
  return {
    id: 'memory',
    name: 'Memory',
    description: 'Knowledge graph memory for cross-session insights',
    enabledByDefault: false,
    transport: {
      type: 'streamable-http',
      url,
    },
  };
}

/**
 * Electron MCP server - desktop app automation.
 * Only available to QA agents. Requires ELECTRON_MCP_ENABLED=true.
 * Uses Chrome DevTools Protocol to connect to Electron apps.
 */
const ELECTRON_SERVER: McpServerConfig = {
  id: 'electron',
  name: 'Electron',
  description: 'Desktop app automation via Chrome DevTools Protocol',
  enabledByDefault: false,
  transport: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'electron-mcp-server'],
  },
};

/**
 * Chrome DevTools MCP server - web browser automation for QA agents.
 *
 * zeenha fork: replaces upstream's Puppeteer server, whose package
 * (`@anthropic-ai/puppeteer-mcp-server`) does not exist on npm, so enabling it
 * could never start anything. Pinned, never `@latest`: its tool names and
 * arguments are part of what the QA prompt tells agents to call.
 * Headless with a throwaway profile, so an agent never sees a person's
 * signed-in browser; usage statistics and CrUX lookups are off so no visited
 * URL leaves the machine.
 */
export const CHROME_DEVTOOLS_MCP_PACKAGE = 'chrome-devtools-mcp@1.11.0';

export interface ChromeDevtoolsOptions {
  /** Chrome binary to launch (e.g. a Playwright headless shell). Default: installed Chrome. */
  executablePath?: string;
  /** Expose the page's own WebMCP tools (Chrome 150+). */
  webmcp?: boolean;
}

export function createChromeDevtoolsServer(options: ChromeDevtoolsOptions = {}): McpServerConfig {
  const args = [
    '-y',
    CHROME_DEVTOOLS_MCP_PACKAGE,
    '--headless',
    '--isolated',
    '--viewport=1280x800',
    '--usageStatistics=false',
    '--performanceCrux=false',
  ];
  if (options.executablePath) args.push('--executablePath', options.executablePath);
  if (options.webmcp) {
    args.push('--categoryExperimentalWebmcp', '--chromeArg=--enable-features=WebMCP');
  }
  return {
    id: 'chrome-devtools',
    name: 'Chrome DevTools',
    description: 'Web browser automation and debugging for frontend validation',
    enabledByDefault: false,
    transport: { type: 'stdio', command: 'npx', args },
  };
}

// =============================================================================
// Registry
// =============================================================================

/** Options for resolving MCP server configurations */
export interface McpRegistryOptions {
  /** Spec directory of the task (not read by any built-in server) */
  specDir?: string;
  /** Memory MCP server URL (if enabled) */
  memoryMcpUrl?: string;
  /** Environment variables for server processes */
  env?: Record<string, string>;
  /** zeenha fork: options for the built-in Chrome DevTools server */
  chromeDevtools?: ChromeDevtoolsOptions;
  /** zeenha fork: project-defined servers, resolved by id after the built-ins */
  customServers?: CustomMcpServerDefinition[];
}

/** zeenha fork: turn a project-defined server into a transport config. */
export function customServerToConfig(def: CustomMcpServerDefinition): McpServerConfig | null {
  if (def.type === 'command' && def.command) {
    return {
      id: def.id,
      name: def.name ?? def.id,
      description: def.description,
      enabledByDefault: false,
      transport: { type: 'stdio', command: def.command, args: def.args ?? [] },
    };
  }
  if (def.type === 'http' && def.url) {
    return {
      id: def.id,
      name: def.name ?? def.id,
      description: def.description,
      enabledByDefault: false,
      transport: { type: 'streamable-http', url: def.url, headers: def.headers },
    };
  }
  return null;
}

/**
 * Get the MCP server configuration for a given server ID.
 *
 * @param serverId - The server identifier to resolve
 * @param options - Registry options for dynamic server configuration
 * @returns Server configuration or null if not recognized
 */
export function getMcpServerConfig(
  serverId: McpServerId | string,
  options: McpRegistryOptions = {},
): McpServerConfig | null {
  switch (serverId) {
    case 'context7':
      return CONTEXT7_SERVER;

    case 'memory': {
      const url = options.memoryMcpUrl ?? options.env?.GRAPHITI_MCP_URL;
      if (!url) return null;
      return createMemoryServer(url);
    }

    case 'electron':
      return ELECTRON_SERVER;

    case 'chrome-devtools':
      return createChromeDevtoolsServer(options.chromeDevtools);

    default: {
      // zeenha fork: upstream returned null here, so a custom server named in
      // AGENT_MCP_<agent>_ADD was silently dropped and never started.
      const def = options.customServers?.find((c) => c.id === serverId);
      return def ? customServerToConfig(def) : null;
    }
  }
}

/**
 * Resolve MCP server configurations for a list of server IDs.
 *
 * Filters out servers that cannot be configured (e.g., missing API keys).
 *
 * @param serverIds - List of server IDs to resolve
 * @param options - Registry options for dynamic server configuration
 * @returns List of resolved server configurations
 */
export function resolveMcpServers(
  serverIds: string[],
  options: McpRegistryOptions = {},
): McpServerConfig[] {
  const configs: McpServerConfig[] = [];

  for (const id of serverIds) {
    const config = getMcpServerConfig(id, options);
    if (config) {
      configs.push(config);
    }
  }

  return configs;
}
