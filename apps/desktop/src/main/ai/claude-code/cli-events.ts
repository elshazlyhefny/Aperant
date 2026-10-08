/**
 * Claude Code stream-json parser
 * ==============================
 *
 * Turns the lines `claude -p --output-format stream-json --verbose
 * --include-partial-messages` prints into the stream parts Aperant's
 * consumers already understand (the AI SDK v6 `fullStream` shapes).
 *
 * What comes from where:
 * - text and reasoning deltas: `stream_event` content_block_delta
 * - step boundaries and usage: `stream_event` message_start / message_delta / message_stop
 * - tool calls and results: NOT from here. The tool bridge emits them when it
 *   actually runs a tool, which is exact (a call the CLI never made never
 *   appears). This parser only records which tools each step asked for, for
 *   `onStepFinish` callers.
 * - final text, structured output, errors: the closing `result` line
 */

import { BRIDGE_TOOL_PREFIX, isRecord } from './cli-args';

export interface CliUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Same numbers under the names Aperant's stream handler reads. */
  promptTokens: number;
  completionTokens: number;
}

export interface CliToolCallRef {
  toolCallId: string;
  toolName: string;
}

export interface CliStep {
  text: string;
  toolCalls: CliToolCallRef[];
  finishReason: string;
  usage: CliUsage;
}

export type ClaudeCodePart =
  /** The CLI is alive (any protocol line); resets inactivity timers, carries no content. */
  | { type: 'keepalive' }
  | { type: 'start-step' }
  | { type: 'text-delta'; id: string; text: string }
  | { type: 'reasoning-delta'; id: string; delta: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'tool-result'; toolCallId: string; toolName: string; input: unknown; output: unknown }
  | { type: 'tool-error'; toolCallId: string; toolName: string; input: unknown; error: unknown }
  | { type: 'finish-step'; finishReason: string; usage: CliUsage; toolCalls: CliToolCallRef[] };

export interface CliFinalResult {
  isError: boolean;
  subtype: string;
  apiErrorStatus: number | null;
  text: string;
  structuredOutput?: unknown;
  stopReason: string | null;
}

export function emptyUsage(): CliUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0 };
}

function makeUsage(input: number, output: number): CliUsage {
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    promptTokens: input,
    completionTokens: output,
  };
}

/** Anthropic stop_reason → AI SDK finish reason. */
export function mapStopReason(stopReason: unknown): string {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'tool_use':
      return 'tool-calls';
    case 'max_tokens':
      return 'length';
    case 'refusal':
      return 'content-filter';
    default:
      return 'other';
  }
}

/** Strip the bridge prefix so logs and progress show Aperant's own tool names. */
export function displayToolName(cliName: string, aliases?: ReadonlyMap<string, string>): string {
  const bare = cliName.startsWith(BRIDGE_TOOL_PREFIX) ? cliName.slice(BRIDGE_TOOL_PREFIX.length) : cliName;
  return aliases?.get(bare) ?? bare;
}

export interface CliEventParser {
  /** Feed one parsed JSON line. */
  handle(event: unknown): void;
  /** Steps completed so far. */
  readonly steps: readonly CliStep[];
  /** The closing `result` line, once seen. */
  readonly result: CliFinalResult | null;
  /** Usage summed over all steps. */
  readonly totalUsage: CliUsage;
}

export interface CliEventParserHooks {
  onPart(part: ClaudeCodePart): void;
  /** Called when the model starts another request; `steps` holds the finished ones. */
  onStepStart?(steps: readonly CliStep[]): void;
  /** Bridge alias → Aperant tool name (for names that had to be shortened). */
  aliases?: ReadonlyMap<string, string>;
}

export function createCliEventParser(hooks: CliEventParserHooks): CliEventParser {
  const steps: CliStep[] = [];
  let result: CliFinalResult | null = null;
  const total = emptyUsage();

  // Current message (= one model request = one step)
  let inMessage = false;
  let messageId = '';
  let stepText = '';
  let stepTools: CliToolCallRef[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason: unknown = null;

  function startMessage(message: Record<string, unknown>): void {
    hooks.onStepStart?.(steps);
    inMessage = true;
    messageId = typeof message.id === 'string' ? message.id : `msg_${steps.length}`;
    stepText = '';
    stepTools = [];
    stopReason = null;
    const usage = isRecord(message.usage) ? message.usage : {};
    inputTokens =
      num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens);
    outputTokens = num(usage.output_tokens);
    hooks.onPart({ type: 'start-step' });
  }

  function finishMessage(): void {
    if (!inMessage) return;
    inMessage = false;
    const usage = makeUsage(inputTokens, outputTokens);
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.totalTokens += usage.totalTokens;
    total.promptTokens += usage.promptTokens;
    total.completionTokens += usage.completionTokens;
    const finishReason = mapStopReason(stopReason);
    steps.push({ text: stepText, toolCalls: stepTools, finishReason, usage });
    hooks.onPart({ type: 'finish-step', finishReason, usage, toolCalls: stepTools });
  }

  function handleStreamEvent(event: Record<string, unknown>): void {
    switch (event.type) {
      case 'message_start':
        if (isRecord(event.message)) startMessage(event.message);
        break;
      case 'content_block_start': {
        const block = event.content_block;
        if (isRecord(block) && block.type === 'tool_use' && typeof block.name === 'string') {
          stepTools.push({
            toolCallId: typeof block.id === 'string' ? block.id : '',
            toolName: displayToolName(block.name, hooks.aliases),
          });
        }
        break;
      }
      case 'content_block_delta': {
        const delta = event.delta;
        if (!isRecord(delta)) break;
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          stepText += delta.text;
          hooks.onPart({ type: 'text-delta', id: messageId, text: delta.text });
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          hooks.onPart({ type: 'reasoning-delta', id: messageId, delta: delta.thinking });
        }
        break;
      }
      case 'message_delta': {
        if (isRecord(event.delta) && event.delta.stop_reason != null) {
          stopReason = event.delta.stop_reason;
        }
        if (isRecord(event.usage)) {
          if (event.usage.output_tokens != null) outputTokens = num(event.usage.output_tokens);
          const input =
            num(event.usage.input_tokens) +
            num(event.usage.cache_creation_input_tokens) +
            num(event.usage.cache_read_input_tokens);
          if (input > 0) inputTokens = input;
        }
        break;
      }
      case 'message_stop':
        finishMessage();
        break;
    }
  }

  function handle(event: unknown): void {
    if (!isRecord(event)) return;
    hooks.onPart({ type: 'keepalive' });
    if (event.type === 'stream_event' && isRecord(event.event)) {
      // Events from a sub-agent carry parent_tool_use_id; the CLI runs none here
      // (built-in tools are off), but never let one split our own steps.
      if (event.parent_tool_use_id != null) return;
      handleStreamEvent(event.event);
      return;
    }
    if (event.type === 'result') {
      finishMessage();
      result = {
        isError: event.is_error === true,
        subtype: typeof event.subtype === 'string' ? event.subtype : 'unknown',
        apiErrorStatus: typeof event.api_error_status === 'number' ? event.api_error_status : null,
        text: typeof event.result === 'string' ? event.result : '',
        ...('structured_output' in event ? { structuredOutput: event.structured_output } : {}),
        stopReason: typeof event.stop_reason === 'string' ? event.stop_reason : null,
      };
    }
  }

  return {
    handle,
    get steps() {
      return steps;
    },
    get result() {
      return result;
    },
    get totalUsage() {
      return { ...total };
    },
  };
}

/**
 * Turn a failed `result` (or a missing one) into an Error whose message the
 * session error classifier recognises: "429 … rate limit" → rate_limited,
 * "401 … authentication failed" → auth_failure.
 */
export function cliFailureError(
  result: CliFinalResult | null,
  exitCode: number | null,
  stderrTail: string,
): Error {
  const detail = (result?.text || stderrTail || '').trim().slice(0, 600);
  const status = result?.apiErrorStatus ?? null;
  if (status === 429 || /rate.?limit|usage limit|limit reached/i.test(detail)) {
    return new Error(`Claude Code CLI: 429 rate limit reached on the subscription. ${detail}`);
  }
  if (status === 401 || status === 403 || /not logged in|please run \/login|invalid api key|oauth token/i.test(detail)) {
    return new Error(
      `Claude Code CLI: 401 authentication failed. Sign in with \`claude\` in a terminal. ${detail}`,
    );
  }
  const code = status != null ? ` (HTTP ${status})` : exitCode != null ? ` (exit code ${exitCode})` : '';
  const kind = result ? result.subtype : 'no result';
  return new Error(`Claude Code CLI failed${code}, ${kind}: ${detail || 'no output'}`);
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
