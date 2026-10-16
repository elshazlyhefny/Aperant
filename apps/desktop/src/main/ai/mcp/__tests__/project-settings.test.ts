/**
 * zeenha fork: the MCP Server Overview's settings must reach the agent path.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseProjectMcpOptions, readProjectMcpOptions } from '../project-settings';
import { getMcpServerConfig } from '../registry';

describe('parseProjectMcpOptions', () => {
  it('uses upstream defaults when nothing is set', () => {
    expect(parseProjectMcpOptions('# CONTEXT7_ENABLED=false\n')).toEqual({
      context7Enabled: true,
      linearMcpEnabled: true,
      electronMcpEnabled: false,
      puppeteerMcpEnabled: false,
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
    writeFileSync(path.join(dir, '.auto-claude', '.env'), 'PUPPETEER_MCP_ENABLED=true\n');
    expect(readProjectMcpOptions(dir).puppeteerMcpEnabled).toBe(true);
  });

  it('falls back to defaults when the file is missing', () => {
    expect(readProjectMcpOptions('/nonexistent/project').context7Enabled).toBe(true);
  });
});

describe('custom servers in the registry', () => {
  it('resolves a custom id that upstream silently dropped', () => {
    const config = getMcpServerConfig('chrome-devtools', {
      customServers: [{ id: 'chrome-devtools', type: 'command', command: 'npx', args: ['-y', 'chrome-devtools-mcp'] }],
    });
    expect(config?.transport).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'chrome-devtools-mcp'] });
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
