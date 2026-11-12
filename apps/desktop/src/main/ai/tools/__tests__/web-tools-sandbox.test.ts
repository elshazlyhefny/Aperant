import { describe, it, expect, vi, beforeEach } from 'vitest';

import { buildToolRegistry } from '../build-registry';
import type { AgentType } from '../registry';
import { webFetchTool } from '../builtin/web-fetch';
import { webSearchTool } from '../builtin/web-search';
import type { ToolContext } from '../types';

const mockBrowse = vi.fn();
const mockSearch = vi.fn();
const mockCreateBrowse = vi.fn(() => ({ name: 'mock', browse: mockBrowse }));
const mockCreateSearch = vi.fn(() => ({ name: 'mock', search: mockSearch }));

vi.mock('../providers', () => ({
  createBrowseProvider: () => mockCreateBrowse(),
  createSearchProvider: () => mockCreateSearch(),
}));

function makeContext(bashSandbox?: string): ToolContext {
  return {
    cwd: '/test',
    projectDir: '/test/project',
    specDir: '/test/specs/001',
    securityProfile: {
      baseCommands: new Set(),
      stackCommands: new Set(),
      scriptCommands: new Set(),
      customCommands: new Set(),
      customScripts: { shellScripts: [] },
      getAllAllowedCommands: () => new Set(),
      bashSandbox,
    },
    abortSignal: new AbortController().signal,
  } as unknown as ToolContext;
}

const AGENTS: AgentType[] = ['coder', 'insights'];

describe('web tools under the Bash sandbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe.each(AGENTS)('registry for %s', (agent) => {
    it.each([undefined, 'off', 'home-hidden', 'restricted-rights'])(
      'keeps web tools when bashSandbox is %s',
      (mode) => {
        const tools = buildToolRegistry().getToolsForAgent(agent, makeContext(mode));
        expect(tools).toHaveProperty('WebFetch');
        expect(tools).toHaveProperty('WebSearch');
      },
    );

    it('removes web tools but keeps Read/Bash for home-hidden-no-network', () => {
      const tools = buildToolRegistry().getToolsForAgent(
        agent,
        makeContext('home-hidden-no-network'),
      );
      expect(tools).not.toHaveProperty('WebFetch');
      expect(tools).not.toHaveProperty('WebSearch');
      expect(tools).toHaveProperty('Read');
      if (agent === 'coder') expect(tools).toHaveProperty('Bash');
    });
  });

  it('WebFetch execute returns the disabled error without touching providers', async () => {
    const result = await webFetchTool.config.execute(
      { url: 'https://example.com', prompt: 'x' },
      makeContext('home-hidden-no-network'),
    );
    expect(result).toBe(
      "Error: WebFetch is disabled because this project's Bash sandbox blocks network access",
    );
    expect(mockCreateBrowse).not.toHaveBeenCalled();
    expect(mockBrowse).not.toHaveBeenCalled();
  });

  it('WebSearch execute returns the disabled error without touching providers', async () => {
    const result = await webSearchTool.config.execute(
      { query: 'node.js', allowed_domains: undefined, blocked_domains: undefined },
      makeContext('home-hidden-no-network'),
    );
    expect(result).toBe(
      "Error: WebSearch is disabled because this project's Bash sandbox blocks network access",
    );
    expect(mockCreateSearch).not.toHaveBeenCalled();
    expect(mockSearch).not.toHaveBeenCalled();
  });
});
