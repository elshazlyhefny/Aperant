/**
 * Tests for MCP Server Registry
 *
 * Validates server configuration resolution, required server lookup,
 * and option-based server filtering.
 */

import { describe, expect, it } from 'vitest';
import { getMcpServerConfig, resolveMcpServers } from '../registry';

// =============================================================================
// getMcpServerConfig
// =============================================================================

describe('getMcpServerConfig', () => {
  describe('context7', () => {
    it('returns the context7 server config', () => {
      const config = getMcpServerConfig('context7');
      expect(config).not.toBeNull();
      expect(config?.id).toBe('context7');
      expect(config?.enabledByDefault).toBe(true);
    });

    it('uses stdio transport with npx', () => {
      const config = getMcpServerConfig('context7');
      expect(config?.transport.type).toBe('stdio');
      if (config?.transport.type === 'stdio') {
        expect(config.transport.command).toBe('npx');
      }
    });
  });

  describe('memory', () => {
    it('returns null when no memory URL provided', () => {
      const config = getMcpServerConfig('memory', {});
      expect(config).toBeNull();
    });

    it('returns config with streamable-http transport when URL is provided', () => {
      const config = getMcpServerConfig('memory', { memoryMcpUrl: 'http://localhost:8080/mcp' });
      expect(config).not.toBeNull();
      expect(config?.transport.type).toBe('streamable-http');
      if (config?.transport.type === 'streamable-http') {
        expect(config.transport.url).toBe('http://localhost:8080/mcp');
      }
    });

    it('reads URL from env.GRAPHITI_MCP_URL option', () => {
      const config = getMcpServerConfig('memory', { env: { GRAPHITI_MCP_URL: 'http://graphiti.local' } });
      expect(config?.transport.type).toBe('streamable-http');
    });
  });

  describe('electron', () => {
    it('returns the electron server config', () => {
      const config = getMcpServerConfig('electron');
      expect(config).not.toBeNull();
      expect(config?.id).toBe('electron');
      expect(config?.enabledByDefault).toBe(false);
    });

    it('uses stdio transport', () => {
      const config = getMcpServerConfig('electron');
      expect(config?.transport.type).toBe('stdio');
    });
  });

  describe('removed built-ins', () => {
    it('no longer knows linear or puppeteer (their npm packages do not exist)', () => {
      expect(getMcpServerConfig('linear', { env: { LINEAR_API_KEY: 'x' } })).toBeNull();
      expect(getMcpServerConfig('puppeteer')).toBeNull();
    });
  });

  describe('chrome-devtools', () => {
    it('launches a pinned, headless, isolated server with telemetry off', () => {
      const config = getMcpServerConfig('chrome-devtools');
      expect(config?.id).toBe('chrome-devtools');
      expect(config?.transport.type).toBe('stdio');
      if (config?.transport.type === 'stdio') {
        expect(config.transport.args).toEqual(expect.arrayContaining([
          'chrome-devtools-mcp@1.11.0', '--headless', '--isolated',
          '--usageStatistics=false', '--performanceCrux=false',
        ]));
        expect(config.transport.args?.some((a) => a.endsWith('@latest'))).toBe(false);
        expect(config.transport.args).not.toContain('--categoryExperimentalWebmcp');
        expect(config.transport.args).not.toContain('--executablePath');
      }
    });

    it('passes the executable and the WebMCP flags only when set', () => {
      const config = getMcpServerConfig('chrome-devtools', {
        chromeDevtools: { executablePath: '/opt/chrome/chrome', webmcp: true },
      });
      if (config?.transport.type !== 'stdio') throw new Error('expected stdio');
      const args = config.transport.args ?? [];
      expect(args[args.indexOf('--executablePath') + 1]).toBe('/opt/chrome/chrome');
      expect(args).toContain('--categoryExperimentalWebmcp');
      expect(args).toContain('--chromeArg=--enable-features=WebMCP');
    });

    it('passes secure origins as one Chrome switch, only when given', () => {
      const config = getMcpServerConfig('chrome-devtools', {
        chromeDevtools: { secureOrigins: ['http://a.test', 'http://b.a.test'] },
      });
      if (config?.transport.type !== 'stdio') throw new Error('expected stdio');
      expect(config.transport.args).toContain(
        '--chromeArg=--unsafely-treat-insecure-origin-as-secure=http://a.test,http://b.a.test',
      );
      const plain = getMcpServerConfig('chrome-devtools');
      if (plain?.transport.type !== 'stdio') throw new Error('expected stdio');
      expect(plain.transport.args?.some((a) => a.includes('unsafely-treat'))).toBe(false);
    });

    it('a built-in id wins over a custom server of the same id', () => {
      const config = getMcpServerConfig('chrome-devtools', {
        customServers: [{ id: 'chrome-devtools', type: 'command', command: 'evil' }],
      });
      if (config?.transport.type !== 'stdio') throw new Error('expected stdio');
      expect(config.transport.command).toBe('npx');
    });
  });

  describe('unknown server', () => {
    it('returns null for unrecognized server ID', () => {
      const config = getMcpServerConfig('nonexistent-server');
      expect(config).toBeNull();
    });
  });
});

// =============================================================================
// resolveMcpServers
// =============================================================================

describe('resolveMcpServers', () => {
  it('returns configs for all recognized server IDs', () => {
    const configs = resolveMcpServers(['context7', 'electron', 'chrome-devtools']);
    expect(configs).toHaveLength(3);
    expect(configs.map((c) => c.id)).toEqual(['context7', 'electron', 'chrome-devtools']);
  });

  it('filters out servers that cannot be configured (e.g. memory without a URL)', () => {
    const configs = resolveMcpServers(['context7', 'memory'], {});
    expect(configs).toHaveLength(1);
    expect(configs[0].id).toBe('context7');
  });

  it('returns empty array for empty input', () => {
    const configs = resolveMcpServers([]);
    expect(configs).toEqual([]);
  });

  it('skips unrecognized server IDs silently', () => {
    const configs = resolveMcpServers(['context7', 'bogus-server-id']);
    expect(configs).toHaveLength(1);
    expect(configs[0].id).toBe('context7');
  });

  it('includes memory server when memoryMcpUrl is provided', () => {
    const configs = resolveMcpServers(['memory'], { memoryMcpUrl: 'http://memory.local' });
    expect(configs).toHaveLength(1);
    expect(configs[0].id).toBe('memory');
  });
});

describe('stdio servers started with npx (zeenha fork)', () => {
  it('Context7 is pinned to a version, so a new publish cannot run here unreviewed', () => {
    const server = getMcpServerConfig('context7', {});
    const args = server?.transport.type === 'stdio' ? (server.transport.args ?? []) : [];
    const pkg = args.find((arg) => arg.startsWith('@upstash/context7-mcp'));
    expect(pkg).toMatch(/^@upstash\/context7-mcp@\d+\.\d+\.\d+$/);
  });
});
