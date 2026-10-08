/**
 * Tool bridge: Aperant's tools, served to the Claude Code CLI over MCP
 * ===================================================================
 *
 * The CLI runs with every built-in tool disabled. It reaches Aperant's own
 * tools (Read, Write, Edit, Bash, Glob, Grep, the build-progress tools, any
 * project MCP tools) through this bridge, so the security profile, path
 * handling and output truncation are exactly the ones the normal engine uses.
 *
 * Transport: MCP Streamable HTTP on 127.0.0.1, an ephemeral port, and a
 * random bearer token per session. Requests without the token get 401
 * (compared in constant time), so another local process or a web page that
 * finds the port cannot call the tools.
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { asSchema } from 'ai';
import type { Tool as AITool } from 'ai';

import { BRIDGE_SERVER_NAME, BRIDGE_TOOL_PREFIX, isRecord } from './cli-args';

/** Longest tool name the API accepts, including the `mcp__aperant__` prefix. */
const MAX_TOOL_NAME = 64;
const VALID_TOOL_NAME = /^[A-Za-z0-9_-]+$/;

export interface ToolBridgeHooks {
  onCall(toolCallId: string, toolName: string, input: unknown): void;
  onResult(toolCallId: string, toolName: string, input: unknown, output: unknown): void;
  onError(toolCallId: string, toolName: string, input: unknown, error: unknown): void;
  abortSignal?: AbortSignal;
  /** Called every `keepaliveMs` while a tool is still running (the CLI prints nothing meanwhile). */
  onBusy?: () => void;
  keepaliveMs?: number;
  /** When true (the run was stopped or cancelled) tool calls are refused without running. */
  isClosed?: () => boolean;
}

export interface ToolBridge {
  url: string;
  token: string;
  /** Bridge name → Aperant tool name, only for names that had to change. */
  aliases: ReadonlyMap<string, string>;
  /** The JSON `--mcp-config` content that points the CLI at this bridge. */
  mcpConfig(): string;
  close(): Promise<void>;
}

interface BridgedTool {
  bridgeName: string;
  name: string;
  tool: AITool;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Give each tool a name the API will accept once prefixed. Names that are
 * already valid are kept, so prompts that say "use the Read tool" still match.
 */
export function assignBridgeNames(names: string[]): Map<string, string> {
  const maxBare = MAX_TOOL_NAME - BRIDGE_TOOL_PREFIX.length;
  const byBridge = new Map<string, string>();
  names.forEach((name, index) => {
    let bridgeName = name;
    if (!VALID_TOOL_NAME.test(name) || name.length > maxBare || byBridge.has(name)) {
      const suffix = `_${index}`;
      bridgeName = name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, maxBare - suffix.length) + suffix;
    }
    byBridge.set(bridgeName, name);
  });
  return byBridge;
}

/** Turn a tool's return value into the text the CLI shows the model. */
export function toolOutputToText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === undefined) return '';
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

async function toJsonSchema(tool: AITool): Promise<Record<string, unknown>> {
  const schema = await asSchema(tool.inputSchema).jsonSchema;
  const json = isRecord(schema) ? { ...schema } : {};
  // MCP requires an object schema at the top level.
  if (json.type !== 'object') return { type: 'object', properties: {} };
  delete json.$schema;
  return json;
}

async function runTool(entry: BridgedTool, toolCallId: string, rawInput: unknown, hooks: ToolBridgeHooks) {
  const { name, tool } = entry;
  let input: unknown = rawInput ?? {};
  if (hooks.isClosed?.()) {
    return { isError: true, content: [{ type: 'text' as const, text: 'The session has been stopped; this tool was not run.' }] };
  }
  hooks.onCall(toolCallId, name, input);

  const busy = hooks.onBusy && hooks.keepaliveMs ? setInterval(hooks.onBusy, hooks.keepaliveMs) : null;
  try {
    const schema = asSchema(tool.inputSchema);
    if (schema.validate) {
      const checked = await schema.validate(input);
      if (!checked.success) {
        throw new Error(`Invalid input for ${name}: ${checked.error.message}`);
      }
      input = checked.value;
    }
    if (typeof tool.execute !== 'function') {
      throw new Error(`Tool ${name} cannot be executed`);
    }
    let output: unknown = await tool.execute(input as never, {
      toolCallId,
      messages: [],
      abortSignal: hooks.abortSignal,
    });
    // Streaming tools yield partial values; the last one is the result.
    if (isAsyncIterable(output)) {
      let last: unknown;
      for await (const value of output) last = value;
      output = last;
    }
    hooks.onResult(toolCallId, name, input, output);
    return { content: [{ type: 'text' as const, text: toolOutputToText(output) }] };
  } catch (error) {
    hooks.onError(toolCallId, name, input, error);
    const message = error instanceof Error ? error.message : String(error);
    return { isError: true, content: [{ type: 'text' as const, text: message }] };
  } finally {
    if (busy) clearInterval(busy);
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  );
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(header ?? '');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function startToolBridge(
  tools: Record<string, AITool>,
  hooks: ToolBridgeHooks,
): Promise<ToolBridge> {
  const names = Object.keys(tools);
  const bridgeNames = assignBridgeNames(names);
  const entries: BridgedTool[] = [];
  for (const [bridgeName, name] of bridgeNames) {
    const tool = tools[name];
    entries.push({
      bridgeName,
      name,
      tool,
      description: tool.description ?? '',
      inputSchema: await toJsonSchema(tool),
    });
  }
  const byBridgeName = new Map(entries.map((e) => [e.bridgeName, e]));
  const aliases = new Map(entries.filter((e) => e.bridgeName !== e.name).map((e) => [e.bridgeName, e.name]));
  const token = randomBytes(32).toString('hex');

  function createMcpServer(): Server {
    const server = new Server({ name: BRIDGE_SERVER_NAME, version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: entries.map((e) => ({
        name: e.bridgeName,
        description: e.description,
        inputSchema: e.inputSchema as { type: 'object'; [key: string]: unknown },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const entry = byBridgeName.get(request.params.name);
      if (!entry) {
        return { isError: true, content: [{ type: 'text' as const, text: `Unknown tool: ${request.params.name}` }] };
      }
      const meta = request.params._meta;
      const cliId = isRecord(meta) ? meta['claudecode/toolUseId'] : undefined;
      const toolCallId = typeof cliId === 'string' && cliId ? cliId : `bridge_${randomUUID()}`;
      return runTool(entry, toolCallId, request.params.arguments, hooks);
    });
    return server;
  }

  const http: HttpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!tokenMatches(req.headers.authorization, token)) {
      res.writeHead(401).end();
      return;
    }
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    // Stateless: one MCP server per request, as the SDK recommends for stateless mode.
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    server
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = http.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/mcp`;

  return {
    url,
    token,
    aliases,
    mcpConfig: () =>
      JSON.stringify({
        mcpServers: {
          [BRIDGE_SERVER_NAME]: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } },
        },
      }),
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}
