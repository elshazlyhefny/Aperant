/**
 * zeenha fork: PR reviewers get the project's MCP servers per agent override,
 * each server connected once per review and closed at the end.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const connects = vi.hoisted(() => ({ calls: [] as string[], fail: new Set<string>(), closed: [] as string[] }));
vi.mock('../../../mcp/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../mcp/client')>();
  return {
    ...actual,
    connectMcpServers: vi.fn(async (configs: Array<{ id: string }>, onError?: (id: string, e: unknown) => void) => {
      const out = [];
      for (const c of configs) {
        connects.calls.push(c.id);
        await new Promise((r) => setTimeout(r, 5));
        if (connects.fail.has(c.id)) {
          onError?.(c.id, new Error('401'));
          continue;
        }
        out.push({ serverId: c.id, tools: { [`mcp__${c.id}__read`]: { description: c.id } }, close: async () => { connects.closed.push(c.id); } });
      }
      return out;
    }),
  };
});

import { hashMcpServer } from '../../../mcp/mcp-approval';
import { createPRReviewMcpSession } from '../pr-review-mcp';

const githubServer = { id: 'github', name: 'GitHub', type: 'http' as const, url: 'https://api.githubcopilot.com/mcp/' };
const approved = { servers: [hashMcpServer(githubServer)], chromeExecutables: [] };

let project: string;
beforeEach(() => {
  connects.calls.length = 0;
  connects.closed.length = 0;
  connects.fail.clear();
  project = mkdtempSync(join(tmpdir(), 'pr-review-mcp-'));
  mkdirSync(join(project, '.auto-claude'));
  writeFileSync(join(project, '.auto-claude', '.env'), [
    'CUSTOM_MCP_SERVERS=[{"id":"github","name":"GitHub","type":"http","url":"https://api.githubcopilot.com/mcp/"}]',
    'AGENT_MCP_pr_security_specialist_ADD=github',
    'AGENT_MCP_pr_logic_specialist_ADD=github',
  ].join('\n'));
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

describe('createPRReviewMcpSession', () => {
  it('gives each reviewer the servers its override adds, connecting each server once', async () => {
    const session = createPRReviewMcpSession(project, '.auto-claude', undefined, approved);

    const [security, logic, quality] = await Promise.all([
      session.toolsFor('pr_security_specialist'),
      session.toolsFor('pr_logic_specialist'),
      session.toolsFor('pr_quality_specialist'),
    ]);

    expect(Object.keys(security)).toEqual(['mcp__github__read']);
    expect(Object.keys(logic)).toEqual(['mcp__github__read']);
    expect(quality).toEqual({}); // no override: no servers
    expect(connects.calls).toEqual(['github']);

    await session.close();
    expect(connects.closed).toEqual(['github']);
    expect(await session.toolsFor('pr_security_specialist')).toEqual({});
  });

  it('logs a server that fails to start and carries on without it', async () => {
    connects.fail.add('github');
    const logs: string[] = [];
    const session = createPRReviewMcpSession(project, '.auto-claude', (l) => logs.push(l), approved);

    expect(await session.toolsFor('pr_security_specialist')).toEqual({});
    expect(logs.join('\n')).toContain('MCP server "github" failed to start (non-fatal): 401');
    await session.close();
  });

  it('connects nothing for a project without MCP settings', async () => {
    rmSync(join(project, '.auto-claude', '.env'));
    const session = createPRReviewMcpSession(project, '.auto-claude', undefined, approved);
    expect(await session.toolsFor('pr_security_specialist')).toEqual({});
    expect(connects.calls).toEqual([]);
  });

  it('never connects a committed server the user has not approved', async () => {
    for (const approvals of [undefined, { servers: [], chromeExecutables: [] }]) {
      const session = createPRReviewMcpSession(project, '.auto-claude', undefined, approvals);
      expect(await session.toolsFor('pr_security_specialist')).toEqual({});
      await session.close();
    }
    expect(connects.calls).toEqual([]);
  });
});
