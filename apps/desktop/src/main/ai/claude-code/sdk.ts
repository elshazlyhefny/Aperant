/**
 * Drop-in `streamText` / `generateText`
 * =====================================
 *
 * Same signatures as the AI SDK's. For every model except a Claude Code
 * (subscription) model they call the AI SDK unchanged. For a Claude Code
 * model WITH tools they run the whole agent loop in the Claude Code CLI,
 * with the tools served through the bridge, and return a result exposing the
 * fields Aperant reads: `fullStream`, `text`, `output`, `usage`,
 * `totalUsage`, `steps`, `finishReason`, plus `onStepFinish` and `stopWhen`.
 *
 * A Claude Code model WITHOUT tools goes through the AI SDK too: the model
 * itself answers those requests (see ./model).
 *
 * Differences from the AI SDK loop, by necessity:
 * - `prepareStep` cannot inject text between steps (the CLI owns the loop),
 *   so mid-session nudges and memory injection do not happen on this path.
 *   The CLI compacts its own context when it fills up.
 * - Errors are thrown from `fullStream` instead of being emitted as `error`
 *   parts, so callers classify them (rate limit, auth) the usual way.
 * - `stopWhen` is evaluated before each further model request; the tools of
 *   the last step have already run, as in the AI SDK.
 */

import * as ai from 'ai';
import type { Tool as AITool } from 'ai';

import {
  effortFromProviderOptions,
  extractImages,
  isRecord,
  type PromptImage,
  renderPrompt,
  systemFromMessages,
} from './cli-args';
import type { ClaudeCodePart, CliStep, CliUsage } from './cli-events';
import type { ClaudeCodeRunResult } from './engine';
import { type ClaudeCodeLanguageModel, isClaudeCodeModel } from './model';

type StreamTextOptions = Parameters<typeof ai.streamText>[0];
type GenerateTextOptions = Parameters<typeof ai.generateText>[0];

/** Fields of the call options this module reads, typed loosely on purpose. */
interface LooseCallOptions {
  model: unknown;
  system?: unknown;
  prompt?: unknown;
  messages?: unknown;
  tools?: Record<string, AITool>;
  stopWhen?: unknown;
  output?: unknown;
  abortSignal?: AbortSignal;
  providerOptions?: unknown;
  onStepFinish?: (step: StepResultLike) => unknown;
}

export interface StepResultLike {
  text: string;
  toolCalls: Array<{ type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }>;
  toolResults: unknown[];
  finishReason: string;
  usage: CliUsage;
  content: unknown[];
}

interface OutputLike {
  responseFormat: PromiseLike<{ type: string; schema?: unknown }>;
  parseCompleteOutput(
    options: { text: string },
    context: { response: unknown; usage: unknown; finishReason: unknown },
  ): Promise<unknown>;
}

type StopCondition = (options: { steps: StepResultLike[] }) => boolean | PromiseLike<boolean>;

/** Options this module accepts under `providerOptions['claude-code']`. */
export interface ClaudeCodeProviderOptions {
  /** Working directory for the CLI (the task worktree), so its environment notes match the tools. */
  cwd?: string;
}

function hasTools(tools: unknown): tools is Record<string, AITool> {
  return isRecord(tools) && Object.keys(tools).length > 0;
}

function usesClaudeCodeEngine(options: LooseCallOptions): boolean {
  return isClaudeCodeModel(options.model) && hasTools(options.tools);
}

// =============================================================================
// Public drop-ins
// =============================================================================

export const streamText = ((options: StreamTextOptions) => {
  const loose = options as unknown as LooseCallOptions;
  if (usesClaudeCodeEngine(loose)) return claudeCodeStreamText(loose);
  return ai.streamText(options);
}) as typeof ai.streamText;

export const generateText = (async (options: GenerateTextOptions) => {
  const loose = options as unknown as LooseCallOptions;
  if (usesClaudeCodeEngine(loose)) return claudeCodeGenerateText(loose);
  return ai.generateText(options);
}) as typeof ai.generateText;

// =============================================================================
// Engine call shared by both
// =============================================================================

interface PreparedRun {
  model: ClaudeCodeLanguageModel;
  system?: string;
  prompt: string;
  images: PromptImage[];
  tools: Record<string, AITool>;
  output?: OutputLike;
  stopConditions: StopCondition[];
}

function prepare(options: LooseCallOptions): PreparedRun {
  const messages = toMessages(options.prompt, options.messages);
  const systemParts = [systemToText(options.system), systemFromMessages(messages)].filter(Boolean);
  const stopWhen = options.stopWhen;
  const stopConditions = (Array.isArray(stopWhen) ? stopWhen : stopWhen ? [stopWhen] : []).filter(
    (c): c is StopCondition => typeof c === 'function',
  );
  return {
    model: options.model as ClaudeCodeLanguageModel,
    system: systemParts.join('\n\n') || undefined,
    prompt: renderPrompt(messages),
    images: extractImages(messages),
    tools: options.tools as Record<string, AITool>,
    output: isOutputLike(options.output) ? options.output : undefined,
    stopConditions,
  };
}

async function execute(
  options: LooseCallOptions,
  prepared: PreparedRun,
  onPart: (part: ClaudeCodePart) => void,
): Promise<ClaudeCodeRunResult> {
  let jsonSchema: Record<string, unknown> | undefined;
  if (prepared.output) {
    const format = await prepared.output.responseFormat;
    if (format.type === 'json' && isRecord(format.schema)) jsonSchema = format.schema;
  }
  const providerOptions = isRecord(options.providerOptions) ? options.providerOptions : {};
  const own = isRecord(providerOptions['claude-code']) ? providerOptions['claude-code'] : {};

  return prepared.model.run({
    modelId: prepared.model.modelId,
    system: prepared.system,
    prompt: prepared.prompt,
    images: prepared.images,
    tools: prepared.tools,
    effort: effortFromProviderOptions(providerOptions),
    jsonSchema,
    cwd: typeof own.cwd === 'string' ? own.cwd : undefined,
    abortSignal: options.abortSignal,
    shouldStop:
      prepared.stopConditions.length > 0
        ? (steps) => {
            // Synchronous when every condition is (stepCountIs is), so the
            // engine can stop before the next step reports or runs anything.
            const asSteps = steps.map(toStepResult);
            const answers = prepared.stopConditions.map((c) => c({ steps: asSteps }));
            if (answers.every((a) => typeof a === 'boolean')) return answers.some(Boolean);
            return Promise.all(answers).then((all) => all.some(Boolean));
          }
        : undefined,
    onPart: (part) => {
      onPart(part);
      if (part.type === 'finish-step' && options.onStepFinish) {
        try {
          void Promise.resolve(options.onStepFinish(stepFromPart(part))).catch(() => undefined);
        } catch {
          // A progress callback must not end the agent's run.
        }
      }
    },
  });
}

async function parseOutput(prepared: PreparedRun, result: ClaudeCodeRunResult): Promise<unknown> {
  if (!prepared.output) return undefined;
  const text = result.structuredOutput !== undefined ? JSON.stringify(result.structuredOutput) : result.text;
  return prepared.output.parseCompleteOutput(
    { text },
    { response: {}, usage: aiUsage(result.usage), finishReason: result.finishReason },
  );
}

// =============================================================================
// streamText
// =============================================================================

function claudeCodeStreamText(options: LooseCallOptions) {
  const prepared = prepare(options);
  const queue = new PartQueue();
  queue.push({ type: 'start' });

  const done = execute(options, prepared, (part) => {
    const mapped = toStreamPart(part);
    if (mapped) queue.push(mapped);
  }).then(
    (result) => {
      queue.push({ type: 'finish', finishReason: result.finishReason, totalUsage: aiUsage(result.usage) });
      queue.end();
      return result;
    },
    (error: unknown) => {
      queue.fail(error);
      throw error;
    },
  );

  const derive = <T>(fn: (result: ClaudeCodeRunResult) => T | Promise<T>): Promise<T> => {
    const promise = done.then(fn);
    promise.catch(() => undefined); // the caller may never read this field; do not report it as unhandled
    return promise;
  };

  return {
    fullStream: queue,
    text: derive((r) => r.text),
    output: derive((r) => parseOutput(prepared, r)),
    usage: derive((r) => aiUsage(r.usage)),
    totalUsage: derive((r) => aiUsage(r.usage)),
    finishReason: derive((r) => r.finishReason),
    steps: derive((r) => r.steps.map(toStepResult)),
  };
}

// =============================================================================
// generateText
// =============================================================================

async function claudeCodeGenerateText(options: LooseCallOptions) {
  const prepared = prepare(options);
  const result = await execute(options, prepared, () => undefined);
  const steps = result.steps.map(toStepResult);
  const last = steps[steps.length - 1];
  return {
    text: result.text,
    output: await parseOutput(prepared, result),
    steps,
    usage: aiUsage(result.usage),
    totalUsage: aiUsage(result.usage),
    finishReason: result.finishReason,
    toolCalls: last?.toolCalls ?? [],
    toolResults: [],
    response: { messages: [] },
  };
}

// =============================================================================
// Helpers
// =============================================================================

/** Map an engine part to the AI SDK v6 fullStream shape Aperant's consumers read. */
export function toStreamPart(part: ClaudeCodePart): Record<string, unknown> | null {
  switch (part.type) {
    case 'keepalive':
      // A real fullStream part type consumers ignore; it keeps inactivity guards honest.
      return { type: 'raw', rawValue: null };
    case 'start-step':
      return { type: 'start-step' };
    case 'text-delta':
      return { type: 'text-delta', id: part.id, text: part.text };
    case 'reasoning-delta':
      return { type: 'reasoning-delta', id: part.id, delta: part.delta, text: part.delta };
    case 'tool-call':
      return { type: 'tool-call', toolCallId: part.toolCallId, toolName: part.toolName, input: part.input };
    case 'tool-result':
      return {
        type: 'tool-result',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
        output: part.output,
      };
    case 'tool-error':
      return {
        type: 'tool-error',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
        error: part.error,
      };
    case 'finish-step':
      return { type: 'finish-step', finishReason: part.finishReason, usage: part.usage };
    default:
      return null;
  }
}

function toStepResult(step: CliStep): StepResultLike {
  return {
    text: step.text,
    toolCalls: step.toolCalls.map((c) => ({ type: 'tool-call', toolCallId: c.toolCallId, toolName: c.toolName, input: undefined })),
    toolResults: [],
    finishReason: step.finishReason,
    usage: step.usage,
    content: [],
  };
}

function stepFromPart(part: Extract<ClaudeCodePart, { type: 'finish-step' }>): StepResultLike {
  return toStepResult({ text: part.text, toolCalls: part.toolCalls, finishReason: part.finishReason, usage: part.usage });
}

function aiUsage(usage: CliUsage) {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
  };
}

function toMessages(prompt: unknown, messages: unknown): Array<{ role: string; content: unknown }> {
  if (Array.isArray(messages)) return messages as Array<{ role: string; content: unknown }>;
  if (Array.isArray(prompt)) return prompt as Array<{ role: string; content: unknown }>;
  if (typeof prompt === 'string') return [{ role: 'user', content: prompt }];
  return [];
}

function systemToText(system: unknown): string {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map(systemToText).filter(Boolean).join('\n\n');
  if (isRecord(system) && typeof system.content === 'string') return system.content;
  return '';
}

function isOutputLike(value: unknown): value is OutputLike {
  return (
    isRecord(value) &&
    typeof value.parseCompleteOutput === 'function' &&
    value.responseFormat != null &&
    typeof (value.responseFormat as PromiseLike<unknown>).then === 'function'
  );
}

/**
 * An async-iterable queue: the engine pushes, one consumer iterates.
 * A failure is thrown from the iterator after the parts already queued.
 */
export class PartQueue implements AsyncIterable<Record<string, unknown>> {
  private items: Record<string, unknown>[] = [];
  private waiting: (() => void) | null = null;
  private finished = false;
  private failure: { error: unknown } | null = null;

  push(item: Record<string, unknown>): void {
    if (this.finished) return;
    this.items.push(item);
    this.wake();
  }

  end(): void {
    this.finished = true;
    this.wake();
  }

  fail(error: unknown): void {
    if (this.finished) return;
    this.failure = { error };
    this.finished = true;
    this.wake();
  }

  private wake(): void {
    const resolve = this.waiting;
    this.waiting = null;
    resolve?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
    while (true) {
      const next = this.items.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.finished) {
        if (this.failure) throw this.failure.error;
        return;
      }
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
    }
  }
}
