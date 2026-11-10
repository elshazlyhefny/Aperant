/**
 * Claude Code CLI: binary lookup, arguments, prompt rendering
 * ===========================================================
 *
 * Pure helpers for running Anthropic models through the installed
 * Claude Code CLI (`claude -p`) instead of calling the Messages API directly.
 *
 * Why the CLI: a Claude subscription (Pro/Max) is meant to be used through
 * Claude Code. Calling the API directly with a subscription OAuth token is
 * refused unless the caller impersonates Claude Code, which we will not do.
 * Running the real CLI uses the subscription the way it is offered.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { isWindows } from '../../platform';
import { buildChildEnv } from '../security/child-env';

/** MCP server name the tool bridge registers under; tools appear as `mcp__aperant__<name>`. */
export const BRIDGE_SERVER_NAME = 'aperant';

/** Prefix the CLI puts in front of every bridged tool name. */
export const BRIDGE_TOOL_PREFIX = `mcp__${BRIDGE_SERVER_NAME}__`;

/** Effort levels accepted by `claude --effort`. */
export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh';

// =============================================================================
// Binary lookup
// =============================================================================

/**
 * Find the `claude` executable. Worker threads cannot use the main-process
 * CLI tool manager (it imports electron), so this is a small standalone lookup:
 * `APERANT_CLAUDE_PATH` first, then PATH, then the installer's usual places.
 * An app started from a desktop menu often has a short PATH, which is why the
 * fallback directories exist.
 */
export function resolveClaudeBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.APERANT_CLAUDE_PATH;
  if (override) return existsSync(override) ? override : null;

  const name = isWindows() ? 'claude.exe' : 'claude';
  const home = homedir();
  const dirs = [
    ...(env.PATH ?? '').split(delimiter).filter(Boolean),
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ];
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// =============================================================================
// Effort
// =============================================================================

/**
 * Map the thinking budget Aperant puts in `providerOptions.anthropic.thinking`
 * (see THINKING_BUDGET_MAP: 1024 / 4096 / 16384 / 32768) to a CLI effort level.
 * No thinking config means "let the CLI decide" (undefined).
 */
export function effortFromProviderOptions(providerOptions: unknown): ClaudeEffort | undefined {
  if (!isRecord(providerOptions)) return undefined;
  const anthropic = providerOptions.anthropic;
  if (!isRecord(anthropic)) return undefined;
  const thinking = anthropic.thinking;
  if (!isRecord(thinking)) return undefined;
  const budget = thinking.budgetTokens;
  if (typeof budget !== 'number' || !Number.isFinite(budget)) return undefined;
  if (budget <= 1024) return 'low';
  if (budget <= 4096) return 'medium';
  if (budget <= 16384) return 'high';
  return 'xhigh';
}

// =============================================================================
// Arguments
// =============================================================================

export interface ClaudeArgsInput {
  modelId: string;
  /** Path to a file holding the system prompt. A file, because prompts can exceed the 128 KB argv limit. */
  systemPromptFile?: string;
  /** Path to the MCP config file (or an inline JSON string when it holds no secret). */
  mcpConfig: string;
  /** Whether the bridge exposes tools (allows `mcp__aperant`). */
  hasTools: boolean;
  effort?: ClaudeEffort;
  /** JSON schema for structured output (`--json-schema`). */
  jsonSchema?: Record<string, unknown>;
  /** Prompt is sent as a stream-json user message (needed to carry images). */
  inputStreamJson?: boolean;
}

/**
 * Build the `claude` argument list.
 *
 * Isolation is the point of most of these flags:
 * - `--tools ""` disables every built-in tool, so the model can only act
 *   through Aperant's own tools (with Aperant's security profile).
 * - `--strict-mcp-config` ignores the user's own MCP servers.
 * - `--setting-sources ""` ignores user/project settings, hooks and plugins.
 * - `--system-prompt-file` replaces Claude Code's prompt, so a repository's
 *   CLAUDE.md is not loaded a second time (Aperant already includes it).
 * - `--permission-mode dontAsk` refuses anything not explicitly allowed,
 *   and `--allowedTools mcp__aperant` allows exactly the bridged tools.
 */
export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', input.modelId,
    '--tools', '',
    '--no-session-persistence',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--mcp-config', input.mcpConfig,
    '--permission-mode', 'dontAsk',
  ];
  if (input.hasTools) {
    args.push('--allowedTools', `mcp__${BRIDGE_SERVER_NAME}`);
  }
  if (input.systemPromptFile) {
    args.push('--system-prompt-file', input.systemPromptFile);
  }
  if (input.effort) {
    args.push('--effort', input.effort);
  }
  if (input.jsonSchema) {
    args.push('--json-schema', JSON.stringify(input.jsonSchema));
  }
  if (input.inputStreamJson) {
    args.push('--input-format', 'stream-json');
  }
  return args;
}

/**
 * Environment for the CLI process. API-key variables are removed so the CLI
 * always uses the signed-in subscription, never an API account someone left
 * in the environment. Nested-session markers are removed so a CLI started
 * from inside another Claude Code session still runs.
 */
export function buildClaudeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Credential variables are scrubbed; the CLI keeps what it needs to sign in.
  const env: NodeJS.ProcessEnv = buildChildEnv(base, {
    keep: ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR'],
  });
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.ELECTRON_RUN_AS_NODE;
  // A bridged tool (e.g. a Bash command running a test suite) may take minutes.
  env.MCP_TOOL_TIMEOUT = env.MCP_TOOL_TIMEOUT ?? '3600000';
  // Aperant's tools already truncate at 100 KB; let that through.
  env.MAX_MCP_OUTPUT_TOKENS = env.MAX_MCP_OUTPUT_TOKENS ?? '50000';
  env.DISABLE_AUTOUPDATER = '1';
  return env;
}

// =============================================================================
// Prompt rendering
// =============================================================================

interface LooseMessage {
  role: string;
  content: unknown;
}

/**
 * Render a message list as the single prompt `claude -p` takes on stdin.
 *
 * One user message is passed through unchanged (the common case: a kickoff
 * message). Anything longer is written out as a labelled transcript, because
 * the CLI cannot be handed earlier assistant turns or tool results as
 * structured messages. System messages are expected to have been removed by
 * the caller (they go to `--system-prompt-file`).
 */
export function renderPrompt(messages: LooseMessage[]): string {
  const turns = messages.filter((m) => m.role !== 'system');
  if (turns.length === 1 && turns[0].role === 'user') {
    return contentToText(turns[0].content);
  }
  if (turns.length === 0) return '';

  const blocks = turns.map((m) => `[${m.role}]\n${contentToText(m.content)}`);
  const last = turns[turns.length - 1];
  const tail = last.role === 'user'
    ? 'Respond to the last user message.'
    : 'Continue from where the assistant left off.';
  return `The conversation so far:\n\n${blocks.join('\n\n')}\n\n${tail}`;
}

/** Collect system messages from a message list (ModelMessage or V3 prompt shape). */
export function systemFromMessages(messages: LooseMessage[]): string {
  return messages
    .filter((m) => m.role === 'system')
    .map((m) => contentToText(m.content))
    .filter(Boolean)
    .join('\n\n');
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content.map(partToText).filter(Boolean).join('\n');
}

function partToText(part: unknown): string {
  if (!isRecord(part)) return typeof part === 'string' ? part : '';
  switch (part.type) {
    case 'text':
      return typeof part.text === 'string' ? part.text : '';
    case 'reasoning':
      return '';
    case 'tool-call':
      return `[called tool ${String(part.toolName)} with ${stringify(part.input ?? part.args)}]`;
    case 'tool-result':
      return `[tool ${String(part.toolName)} returned: ${stringify(unwrapToolOutput(part.output ?? part.result))}]`;
    case 'image':
      return '[image attached]';
    case 'file':
      return isImageMediaType(part.mediaType) ? '[image attached]' : '[file content omitted]';
    default:
      return `[${String(part.type)} content omitted]`;
  }
}

/** An image taken from a prompt, ready for the CLI's stream-json input. */
export interface PromptImage {
  mediaType: string;
  /** Base64 data without a `data:` prefix. */
  data: string;
}

function isImageMediaType(value: unknown): value is string {
  return typeof value === 'string' && value.toLowerCase().startsWith('image/');
}

function toBase64(data: unknown): string | null {
  if (typeof data === 'string') {
    if (/^https?:\/\//i.test(data)) return null;
    const match = /^data:[^,]*;base64,(.*)$/s.exec(data);
    return match ? match[1] : data;
  }
  if (data instanceof Uint8Array) return Buffer.from(data).toString('base64');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('base64');
  return null;
}

/**
 * Images in the last user message (ModelMessage `image` parts and V3 `file`
 * parts with an image media type). Remote URLs are skipped. Earlier turns are
 * rendered as text, so their images are not sent again.
 */
export function extractImages(messages: LooseMessage[]): PromptImage[] {
  let last: LooseMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      last = messages[i];
      break;
    }
  }
  if (!last || !Array.isArray(last.content)) return [];
  const images: PromptImage[] = [];
  for (const part of last.content) {
    if (!isRecord(part)) continue;
    let raw: unknown;
    let mediaType: unknown = part.mediaType;
    if (part.type === 'image') {
      raw = part.image ?? part.data;
      if (!isImageMediaType(mediaType)) {
        const dataUrl = typeof raw === 'string' ? /^data:([^;,]+)/.exec(raw) : null;
        mediaType = dataUrl ? dataUrl[1] : 'image/png';
      }
    } else if (part.type === 'file' && isImageMediaType(mediaType)) {
      raw = part.data;
    } else {
      continue;
    }
    const data = toBase64(raw);
    if (data) images.push({ mediaType: mediaType as string, data });
  }
  return images;
}

/** The single stream-json user message line carrying the prompt text and its images. */
export function buildStreamJsonUserMessage(prompt: string, images: PromptImage[]): string {
  const content: unknown[] = images.map((image) => ({
    type: 'image',
    source: { type: 'base64', media_type: image.mediaType, data: image.data },
  }));
  content.push({ type: 'text', text: prompt });
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;
}

/** V3 tool results arrive as `{ type: 'text' | 'json' | ..., value }`. */
function unwrapToolOutput(output: unknown): unknown {
  if (isRecord(output) && typeof output.type === 'string' && 'value' in output) {
    return output.value;
  }
  return output;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
