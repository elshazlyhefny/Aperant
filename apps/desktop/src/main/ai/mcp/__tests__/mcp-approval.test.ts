/**
 * zeenha fork: project-declared MCP launches need the user's approval.
 */
import { describe, expect, it } from 'vitest';
import { hashMcpServer, isChromeExecutableApproved, isServerApproved } from '../mcp-approval';
import { parseProjectMcpOptions } from '../project-settings';
import { checkMcpCommand } from '../command-policy';
import type { CustomMcpServerDefinition } from '../types';

const ref = (name: string): string => `$${'{'}${name}}`;

const base: CustomMcpServerDefinition = { id: 'srv', type: 'command', command: 'npx', args: ['-y', 'pkg'] };

describe('hashMcpServer', () => {
  it('is stable for the same definition', () => {
    expect(hashMcpServer(base)).toBe(hashMcpServer({ ...base, args: ['-y', 'pkg'] }));
    expect(hashMcpServer(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when id, command, args or url change', () => {
    const h = hashMcpServer(base);
    expect(hashMcpServer({ ...base, id: 'other' })).not.toBe(h);
    expect(hashMcpServer({ ...base, command: 'node' })).not.toBe(h);
    expect(hashMcpServer({ ...base, args: ['-y', 'pkg2'] })).not.toBe(h);
    const http: CustomMcpServerDefinition = { id: 'h', type: 'http', url: 'https://a.example/mcp' };
    expect(hashMcpServer({ ...http, url: 'https://b.example/mcp' })).not.toBe(hashMcpServer(http));
  });

  it('ignores headers, name and description', () => {
    const http: CustomMcpServerDefinition = { id: 'h', type: 'http', url: 'https://a.example/mcp', headers: { A: '1' } };
    expect(hashMcpServer({ ...http, headers: { A: '2' } })).toBe(hashMcpServer(http));
    expect(hashMcpServer({ ...http, name: 'x', description: 'y' })).toBe(hashMcpServer(http));
  });

  it('changes when a referenced variable changes value in the .env', () => {
    const custom = JSON.stringify([{ id: 'v', type: 'command', command: 'npx', args: [ref('PKG')] }]);
    const a = parseProjectMcpOptions(`PKG=one\nCUSTOM_MCP_SERVERS=${custom}`).customServers?.[0];
    const b = parseProjectMcpOptions(`PKG=two\nCUSTOM_MCP_SERVERS=${custom}`).customServers?.[0];
    expect(a && b && hashMcpServer(a)).not.toBe(b && hashMcpServer(b));
  });
});

describe('approval helpers', () => {
  it('approves only listed hashes and fails closed without approvals', () => {
    const approvals = { servers: [hashMcpServer(base)], chromeExecutables: ['/opt/chrome'] };
    expect(isServerApproved(base, approvals)).toBe(true);
    expect(isServerApproved({ ...base, id: 'x' }, approvals)).toBe(false);
    expect(isServerApproved(base, undefined)).toBe(false);
    expect(isChromeExecutableApproved('/opt/chrome', approvals)).toBe(true);
    expect(isChromeExecutableApproved('/opt/other', approvals)).toBe(false);
    expect(isChromeExecutableApproved('/opt/chrome', undefined)).toBe(false);
  });
});

describe('command policy is not the trust boundary', () => {
  it('lets local scripts and arbitrary packages through the allowlist', () => {
    expect(checkMcpCommand('node', ['tools/payload.js']).ok).toBe(true);
    expect(checkMcpCommand('npx', ['attacker-package']).ok).toBe(true);
  });
});
