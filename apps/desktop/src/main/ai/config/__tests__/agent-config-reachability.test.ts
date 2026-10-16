/**
 * Every tool and MCP server an agent config names must be one an agent can
 * actually reach.
 *
 * The build agents used to list an 'auto-claude' MCP server (and six
 * mcp__auto-claude__* tools) that nothing provided: the MCP registry resolves
 * that id to no server, and buildToolRegistry() never registered the tools. The
 * agent tools screen still advertised them as "always enabled".
 */

import { describe, expect, it } from 'vitest';

import { buildToolRegistry } from '../../tools/build-registry';
import { getMcpServerConfig } from '../../mcp/registry';
import { AGENT_CONFIGS } from '../agent-configs';

/** 'browser' is not a server: getRequiredMcpServers() swaps it for electron/chrome-devtools. */
const DYNAMIC_SERVER_IDS = new Set(['browser']);

/** Every option a server can need, so only an id with no server resolves to null. */
const FULL_OPTIONS = {
  memoryMcpUrl: 'http://memory.local',
  specDir: '/project/.auto-claude/specs/001-x',
};

describe('agent config reachability', () => {
  const registered = new Set(buildToolRegistry().getRegisteredNames());

  it('names only tools the tool registry provides', () => {
    const missing: string[] = [];
    for (const [agent, config] of Object.entries(AGENT_CONFIGS)) {
      for (const tool of config.tools) {
        if (!registered.has(tool)) missing.push(`${agent}: ${tool}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('names only MCP servers the MCP registry can start', () => {
    const missing: string[] = [];
    for (const [agent, config] of Object.entries(AGENT_CONFIGS)) {
      for (const id of [...config.mcpServers, ...(config.mcpServersOptional ?? [])]) {
        if (DYNAMIC_SERVER_IDS.has(id)) continue;
        if (getMcpServerConfig(id, FULL_OPTIONS) === null) missing.push(`${agent}: ${id}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
