/**
 * zeenha fork: the settings page's Health and Test must agree with what agents
 * can actually do.
 */
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, app: { getPath: () => tmpdir() } }));
vi.mock('../../project-store', () => ({ projectStore: { getProjects: () => [] } }));
vi.mock('../../app-logger', () => ({ appLog: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
const createMcpClient = vi.fn();
// A plain function can stand in for the spy when a case needs a rejection:
// Vitest's spy also tracks the rejected promise and reports it as a failure.
let failWith: Error | null = null;
vi.mock('../../ai/mcp/client', () => ({
  createMcpClient: (...a: unknown[]) => (failWith ? Promise.reject(failWith) : createMcpClient(...a)),
}));

import { checkMcpHealth, testMcpConnection } from '../mcp-handlers';
import type { CustomMcpServer } from '../../../shared/types/project';

const http: CustomMcpServer = { id: 'gh', name: 'GitHub', type: 'http', url: 'https://mcp.example/mcp' };
const boost: CustomMcpServer = {
  id: 'boost', name: 'Boost', type: 'command', command: 'docker',
  args: ['exec', '-i', 'zeenha_app', 'php', 'artisan', 'boost:mcp'],
};

describe('quick health of an HTTP MCP endpoint', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('treats 405 on GET as reachable (Streamable HTTP refuses GET)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 405, statusText: 'Method Not Allowed' }));
    const result = await checkMcpHealth(http);
    expect(result.status).toBe('healthy');
  });

  it('still reports a 500 as unhealthy and a 401 as needing auth', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    expect((await checkMcpHealth(http)).status).toBe('unhealthy');
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    expect((await checkMcpHealth(http)).status).toBe('needs_auth');
  });
});

describe('Test connection uses the agents\' MCP client', () => {
  beforeEach(() => {
    createMcpClient.mockReset();
    failWith = null;
  });

  it('reports the tools the real client listed', async () => {
    createMcpClient.mockResolvedValue({ serverId: 'gh', tools: { b: {}, a: {} }, close: vi.fn().mockResolvedValue(undefined) });
    const result = await testMcpConnection(http);
    expect(result).toMatchObject({ success: true, tools: ['a', 'b'], message: 'Connected successfully, 2 tools available' });
    expect(createMcpClient.mock.calls[0][0].transport).toMatchObject({ type: 'streamable-http', url: 'https://mcp.example/mcp' });
  });

  it('maps an auth failure', async () => {
    failWith = new Error('HTTP 401 Unauthorized');
    expect(await testMcpConnection(http)).toMatchObject({ success: false, message: 'Authentication failed' });
  });

  it('runs an allowed docker exec server through the same client', async () => {
    createMcpClient.mockResolvedValue({ serverId: 'boost', tools: { x: {} }, close: vi.fn().mockResolvedValue(undefined) });
    expect((await testMcpConnection(boost)).success).toBe(true);
    expect(createMcpClient.mock.calls[0][0].transport).toMatchObject({ type: 'stdio', command: 'docker' });
  });

  it('refuses docker run before starting anything', async () => {
    const result = await testMcpConnection({ ...boost, args: ['run', '-v', '/:/host', 'alpine', 'sh'] });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/docker exec/);
    expect(createMcpClient).not.toHaveBeenCalled();
  });
});
