import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { tool } from 'ai';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod/v3';

import { BRIDGE_TOOL_PREFIX } from '../cli-args';
import { assignBridgeNames, startToolBridge, type ToolBridge, toolOutputToText } from '../tool-bridge';

const bridges: ToolBridge[] = [];
afterEach(async () => {
  while (bridges.length) await bridges.pop()?.close();
});

async function connect(bridge: ToolBridge, token = bridge.token) {
  const client = new Client({ name: 'test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(bridge.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

function makeTools(log: string[]) {
  return {
    Read: tool({
      description: 'Read a file',
      inputSchema: z.object({ file_path: z.string() }),
      execute: async ({ file_path }) => {
        log.push(file_path);
        return { content: `contents of ${file_path}` };
      },
    }),
    Fail: tool({
      description: 'Always fails',
      inputSchema: z.object({}),
      execute: async (): Promise<string> => {
        throw new Error('Security hook denied Fail: not allowed');
      },
    }),
  };
}

describe('tool bridge', () => {
  it('lists the tools with JSON schemas and runs them, reporting call and result', async () => {
    const log: string[] = [];
    const events: string[] = [];
    const bridge = await startToolBridge(makeTools(log), {
      onCall: (id, name) => events.push(`call:${name}:${id}`),
      onResult: (_id, name, _input, output) => events.push(`result:${name}:${JSON.stringify(output)}`),
      onError: (_id, name) => events.push(`error:${name}`),
    });
    bridges.push(bridge);
    expect(bridge.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

    const client = await connect(bridge);
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual(['Fail', 'Read']);
    const read = listed.tools.find((t) => t.name === 'Read');
    expect(read?.inputSchema).toMatchObject({ type: 'object', properties: { file_path: { type: 'string' } } });

    const result = await client.callTool({
      name: 'Read',
      arguments: { file_path: 'src/a.ts' },
      _meta: { 'claudecode/toolUseId': 'toolu_42' },
    });
    expect(log).toEqual(['src/a.ts']);
    expect(result.isError).toBeFalsy();
    expect((result.content as Array<{ text: string }>)[0].text).toContain('contents of src/a.ts');
    expect(events).toEqual(['call:Read:toolu_42', 'result:Read:{"content":"contents of src/a.ts"}']);
    await client.close();
  });

  it('returns an image tool result as an MCP image block and does not log the base64', async () => {
    const results: unknown[] = [];
    const imageTool = tool({
      description: 'img',
      inputSchema: z.object({}),
      execute: async () => ({ type: 'image', filename: 'a.png', mediaType: 'image/png', data: 'QUJD', bytes: 3 }),
    });
    const bridge = await startToolBridge({ Read: imageTool }, {
      onCall: () => undefined,
      onResult: (_id, _name, _input, output) => results.push(output),
      onError: () => undefined,
    });
    bridges.push(bridge);
    const client = await connect(bridge);
    const result = await client.callTool({ name: 'Read', arguments: {} });
    expect(result.content).toEqual([
      { type: 'text', text: '[Image file: a.png]' },
      { type: 'image', data: 'QUJD', mimeType: 'image/png' },
    ]);
    expect(JSON.stringify(results)).not.toContain('QUJD');
    await client.close();
  });

  it('refuses a request without the right token', async () => {
    const bridge = await startToolBridge(makeTools([]), { onCall: () => undefined, onResult: () => undefined, onError: () => undefined });
    bridges.push(bridge);
    const response = await fetch(bridge.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer wrong' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
    const noHeader = await fetch(bridge.url, { method: 'POST', body: '{}' });
    expect(noHeader.status).toBe(401);
    await expect(connect(bridge, 'x'.repeat(64))).rejects.toThrow();
  });

  it('returns tool errors and invalid input as errors without running the tool', async () => {
    const log: string[] = [];
    const errors: string[] = [];
    const bridge = await startToolBridge(makeTools(log), {
      onCall: () => undefined,
      onResult: () => undefined,
      onError: (_id, name, _input, error) => errors.push(`${name}: ${error instanceof Error ? error.message : error}`),
    });
    bridges.push(bridge);
    const client = await connect(bridge);

    const bad = await client.callTool({ name: 'Read', arguments: { file_path: 42 } });
    expect(bad.isError).toBe(true);
    expect(log).toEqual([]);

    const denied = await client.callTool({ name: 'Fail', arguments: {} });
    expect(denied.isError).toBe(true);
    expect((denied.content as Array<{ text: string }>)[0].text).toContain('Security hook denied');

    const unknown = await client.callTool({ name: 'Nope', arguments: {} });
    expect(unknown.isError).toBe(true);
    expect(errors).toHaveLength(2);
    await client.close();
  });

  it('refuses tool calls once the session is stopped, without running them', async () => {
    const log: string[] = [];
    let closed = false;
    const bridge = await startToolBridge(makeTools(log), {
      onCall: () => undefined, onResult: () => undefined, onError: () => undefined,
      isClosed: () => closed,
    });
    bridges.push(bridge);
    const client = await connect(bridge);
    closed = true;
    const result = await client.callTool({ name: 'Read', arguments: { file_path: 'a' } });
    expect(result.isError).toBe(true);
    expect(log).toEqual([]);
    await client.close();
  });

  it('reports liveness while a long tool runs, and stops when it ends', async () => {
    let busy = 0;
    const slow = tool({
      description: 'slow',
      inputSchema: z.object({}),
      execute: async () => {
        await new Promise((r) => setTimeout(r, 120));
        return 'done';
      },
    });
    const bridge = await startToolBridge({ Slow: slow }, {
      onCall: () => undefined, onResult: () => undefined, onError: () => undefined,
      onBusy: () => { busy++; }, keepaliveMs: 20,
    });
    bridges.push(bridge);
    const client = await connect(bridge);
    await client.callTool({ name: 'Slow', arguments: {} });
    const during = busy;
    expect(during).toBeGreaterThanOrEqual(3);
    await new Promise((r) => setTimeout(r, 80));
    expect(busy).toBe(during);
    await client.close();
  });

  it('gives over-long or invalid names a short alias and maps it back', async () => {
    const long = `mcp__linear__${'x'.repeat(60)}`;
    const names = assignBridgeNames(['Read', long, 'with space']);
    const maxBare = 64 - BRIDGE_TOOL_PREFIX.length;
    for (const bridgeName of names.keys()) {
      expect(bridgeName).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(bridgeName.length).toBeLessThanOrEqual(maxBare);
    }
    expect(names.get('Read')).toBe('Read');
    expect([...names.values()]).toEqual(['Read', long, 'with space']);
  });

  it('renders tool output as text', () => {
    expect(toolOutputToText('plain')).toBe('plain');
    expect(toolOutputToText({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(toolOutputToText(undefined)).toBe('');
  });
});
