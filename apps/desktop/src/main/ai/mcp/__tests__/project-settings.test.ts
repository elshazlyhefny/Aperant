/**
 * zeenha fork: the MCP Server Overview's settings must reach the agent path.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { mcpResolveOptionsForAgent, parseProjectMcpOptions, readProjectMcpOptions } from '../project-settings';
import { getRequiredMcpServers } from '../../config/agent-configs';
import { getMcpServerConfig } from '../registry';

/** A literal `${NAME}` reference, as a person would type it into the server JSON. */
const ref = (name: string): string => `$${'{'}${name}}`;

describe('parseProjectMcpOptions', () => {
  it('uses upstream defaults when nothing is set', () => {
    expect(parseProjectMcpOptions('# CONTEXT7_ENABLED=false\n')).toEqual({
      context7Enabled: true,
      electronMcpEnabled: false,
      chromeDevtoolsMcpEnabled: false,
      chromeDevtoolsWebmcp: false,
    });
  });

  it('reads toggles, per-agent overrides and custom servers', () => {
    const custom = [
      { id: 'chrome-devtools', name: 'Chrome DevTools', type: 'command', command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.11.0'] },
      { id: 'remote', type: 'http', url: 'https://mcp.example.com/mcp' },
    ];
    const opts = parseProjectMcpOptions([
      'CONTEXT7_ENABLED=false',
      'ELECTRON_MCP_ENABLED=true',
      'AGENT_MCP_qa_reviewer_ADD=chrome-devtools, remote',
      'AGENT_MCP_coder_REMOVE=context7',
      `CUSTOM_MCP_SERVERS=${JSON.stringify(custom)}`,
    ].join('\n'));

    expect(opts.context7Enabled).toBe(false);
    expect(opts.electronMcpEnabled).toBe(true);
    expect(opts.agentMcpOverrides).toEqual({
      qa_reviewer: { add: ['chrome-devtools', 'remote'] },
      coder: { remove: ['context7'] },
    });
    expect(opts.customServers?.map((s) => s.id)).toEqual(['chrome-devtools', 'remote']);
  });

  it('drops malformed custom servers and keeps the valid ones', () => {
    const custom = [
      { id: 'ok', type: 'command', command: 'npx' },
      { id: 'no-command', type: 'command' },
      { id: 'bad url', type: 'http', url: 'https://x' },
      { id: 'file', type: 'http', url: 'file:///etc/passwd' },
      { id: 'args', type: 'command', command: 'npx', args: [1] },
    ];
    const opts = parseProjectMcpOptions(`CUSTOM_MCP_SERVERS=${JSON.stringify(custom)}`);
    expect(opts.customServers?.map((s) => s.id)).toEqual(['ok']);
  });

  it('reads the Chrome DevTools options and keeps only an absolute executable', () => {
    const opts = parseProjectMcpOptions([
      'CHROME_DEVTOOLS_MCP_ENABLED=true',
      'CHROME_DEVTOOLS_WEBMCP=true',
      'CHROME_DEVTOOLS_EXECUTABLE=/opt/chrome/chrome',
    ].join('\n'));
    expect(opts.chromeDevtoolsMcpEnabled).toBe(true);
    expect(opts.chromeDevtoolsWebmcp).toBe(true);
    expect(opts.chromeDevtoolsExecutable).toBe('/opt/chrome/chrome');
    expect(parseProjectMcpOptions('CHROME_DEVTOOLS_EXECUTABLE=chrome').chromeDevtoolsExecutable).toBeUndefined();
  });

  it('expands variable references in headers and args from the same file', () => {
    const custom = [{
      id: 'github',
      type: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { Authorization: `Bearer ${ref('GITHUB_TOKEN')}`, 'X-MCP-Readonly': 'true' },
    }];
    const opts = parseProjectMcpOptions(`GITHUB_TOKEN=gho_abc\nCUSTOM_MCP_SERVERS=${JSON.stringify(custom)}`);
    expect(opts.customServers?.[0].headers).toEqual({ Authorization: 'Bearer gho_abc', 'X-MCP-Readonly': 'true' });
  });

  it('drops a server whose referenced variable is missing or empty', () => {
    const custom = [
      { id: 'gh', type: 'http', url: 'https://x.example/mcp', headers: { Authorization: `Bearer ${ref('GITHUB_TOKEN')}` } },
      { id: 'cmd', type: 'command', command: 'npx', args: ['--key', ref('EMPTY_ONE')] },
      { id: 'plain', type: 'command', command: 'npx' },
    ];
    const opts = parseProjectMcpOptions(`EMPTY_ONE=\nCUSTOM_MCP_SERVERS=${JSON.stringify(custom)}`);
    expect(opts.customServers?.map((s) => s.id)).toEqual(['plain']);
  });

  it('never reads the process environment', () => {
    process.env.ZEENHA_TEST_SECRET = 'from-process';
    try {
      const custom = [{ id: 'x', type: 'command', command: 'npx', args: [ref('ZEENHA_TEST_SECRET')] }];
      const opts = parseProjectMcpOptions(`CUSTOM_MCP_SERVERS=${JSON.stringify(custom)}`);
      expect(opts.customServers).toBeUndefined();
    } finally {
      delete process.env.ZEENHA_TEST_SECRET;
    }
  });

  it('treats invalid JSON as no custom servers', () => {
    expect(parseProjectMcpOptions('CUSTOM_MCP_SERVERS=[{').customServers).toBeUndefined();
  });
});

describe('readProjectMcpOptions', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('reads <project>/<autoBuildPath>/.env', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'mcp-settings-'));
    mkdirSync(path.join(dir, '.auto-claude'));
    writeFileSync(path.join(dir, '.auto-claude', '.env'), 'CHROME_DEVTOOLS_MCP_ENABLED=true\n');
    expect(readProjectMcpOptions(dir).chromeDevtoolsMcpEnabled).toBe(true);
  });

  it('falls back to defaults when the file is missing', () => {
    expect(readProjectMcpOptions('/nonexistent/project').context7Enabled).toBe(true);
  });
});

describe('custom servers in the registry', () => {
  it('resolves a custom id that upstream silently dropped', () => {
    const config = getMcpServerConfig('laravel-boost', {
      customServers: [{ id: 'laravel-boost', type: 'command', command: 'docker', args: ['compose', 'exec', '-T', 'app', 'php', 'artisan', 'boost:mcp'] }],
    });
    expect(config?.transport).toEqual({ type: 'stdio', command: 'docker', args: ['compose', 'exec', '-T', 'app', 'php', 'artisan', 'boost:mcp'] });
  });

  it('maps an http custom server to streamable-http', () => {
    const config = getMcpServerConfig('remote', {
      customServers: [{ id: 'remote', type: 'http', url: 'https://mcp.example.com/mcp', headers: { A: 'b' } }],
    });
    expect(config?.transport).toEqual({ type: 'streamable-http', url: 'https://mcp.example.com/mcp', headers: { A: 'b' } });
  });

  it('still returns null for an unknown id', () => {
    expect(getMcpServerConfig('nope', { customServers: [] })).toBeNull();
  });
});

describe('mcpResolveOptionsForAgent', () => {
  const session = {
    chromeDevtoolsMcpEnabled: true,
    agentMcpOverrides: {
      qa_reviewer: { add: ['laravel-boost'], remove: ['context7'] },
    },
  };

  it("applies an agent's own overrides to that agent", () => {
    const opts = mcpResolveOptionsForAgent(session, 'qa_reviewer');
    expect(opts.agentMcpAdd).toBe('laravel-boost');
    const servers = getRequiredMcpServers('qa_reviewer', { ...opts, customServerIds: ['laravel-boost'] });
    expect(servers).toContain('laravel-boost');
    expect(servers).toContain('chrome-devtools');
    expect(servers).not.toContain('context7');
  });

  it("does not leak one agent's overrides onto another", () => {
    const opts = mcpResolveOptionsForAgent(session, 'coder');
    const servers = getRequiredMcpServers('coder', { ...opts, customServerIds: ['laravel-boost'] });
    expect(servers).not.toContain('laravel-boost');
    expect(servers).toContain('context7');
  });

  it('defaults to Context7 on and everything else off', () => {
    expect(mcpResolveOptionsForAgent(undefined, 'coder')).toMatchObject({
      context7Enabled: true,
      memoryEnabled: false,
      electronMcpEnabled: false,
      chromeDevtoolsMcpEnabled: false,
    });
  });
});
