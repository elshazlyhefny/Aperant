/**
 * ClaudeCodeLanguageModel
 * =======================
 *
 * An AI SDK v6 language model (spec v3) backed by the Claude Code CLI.
 * The provider factory returns one of these for an Anthropic subscription
 * account, so every place that holds "the model" keeps working.
 *
 * On its own it answers single requests WITHOUT tools: titles, commit
 * messages, summaries, structured JSON. Conversations WITH tools are run by
 * the drop-in `streamText`/`generateText` in `./sdk`, which give the CLI the
 * tools through the bridge. A tool call that reaches this class directly
 * would mean a caller bypassed `./sdk`; it fails loudly rather than silently
 * answering without the tools.
 */

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from '@ai-sdk/provider';

import { effortFromProviderOptions, extractImages, isRecord, renderPrompt, systemFromMessages } from './cli-args';
import type { CliUsage } from './cli-events';
import { type ClaudeCodeRunOptions, type ClaudeCodeRunResult, runClaudeCode } from './engine';

export const CLAUDE_CODE_PROVIDER = 'claude-code';

const BRAND = Symbol.for('aperant.claude-code-model');

export type ClaudeCodeRunner = (options: ClaudeCodeRunOptions) => Promise<ClaudeCodeRunResult>;

export class ClaudeCodeLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3' as const;
  readonly provider = CLAUDE_CODE_PROVIDER;
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]> = {};
  readonly [BRAND] = true;
  /** Exposed for the `./sdk` drop-ins and for tests. */
  readonly run: ClaudeCodeRunner;
  /** The selected account's OAuth token; private so it never reaches a log or a serialised object. */
  readonly #oauthToken: string | undefined;

  readonly #configDir: string | undefined;

  constructor(modelId: string, run: ClaudeCodeRunner = runClaudeCode, oauthToken?: string, configDir?: string) {
    this.modelId = modelId;
    this.#oauthToken = oauthToken;
    this.#configDir = configDir;
    this.run = (options) => run({
      ...options,
      oauthToken: options.oauthToken ?? this.#oauthToken,
      configDir: options.configDir ?? this.#configDir,
    });
  }

  private prepare(options: LanguageModelV3CallOptions) {
    if (options.tools && options.tools.length > 0) {
      throw new Error(
        'A Claude Code (subscription) model was given tools outside the Claude Code engine. ' +
          "Call streamText/generateText from 'ai/claude-code/sdk' for tool use.",
      );
    }
    const messages = options.prompt as Array<{ role: string; content: unknown }>;
    const jsonSchema =
      options.responseFormat?.type === 'json' && isRecord(options.responseFormat.schema)
        ? (options.responseFormat.schema as Record<string, unknown>)
        : undefined;
    return {
      system: systemFromMessages(messages) || undefined,
      prompt: renderPrompt(messages),
      images: extractImages(messages),
      jsonSchema,
      effort: effortFromProviderOptions(options.providerOptions),
    };
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const prepared = this.prepare(options);
    const result = await this.run({
      modelId: this.modelId,
      ...prepared,
      abortSignal: options.abortSignal,
      onPart: () => undefined,
    });
    const content: LanguageModelV3Content[] = [{ type: 'text', text: finalText(result, prepared.jsonSchema) }];
    return {
      content,
      finishReason: v3FinishReason(result.finishReason),
      usage: v3Usage(result.usage),
      warnings: [],
    };
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const prepared = this.prepare(options);
    const run = this.run;
    const modelId = this.modelId;
    // Structured output must arrive as one JSON text, so prose deltas are not streamed then.
    const streamText = !prepared.jsonSchema;

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        const open = new Set<string>();
        const close = () => {
          for (const key of open) {
            const [kind, id] = splitKey(key);
            controller.enqueue(kind === 'text' ? { type: 'text-end', id } : { type: 'reasoning-end', id });
          }
          open.clear();
        };
        try {
          const result = await run({
            modelId,
            ...prepared,
            abortSignal: options.abortSignal,
            onPart: (part) => {
              if (part.type === 'text-delta' && streamText) {
                const key = `text:${part.id}`;
                if (!open.has(key)) {
                  open.add(key);
                  controller.enqueue({ type: 'text-start', id: part.id });
                }
                controller.enqueue({ type: 'text-delta', id: part.id, delta: part.text });
              } else if (part.type === 'reasoning-delta') {
                const key = `reasoning:${part.id}`;
                if (!open.has(key)) {
                  open.add(key);
                  controller.enqueue({ type: 'reasoning-start', id: part.id });
                }
                controller.enqueue({ type: 'reasoning-delta', id: part.id, delta: part.delta });
              }
            },
          });
          close();
          if (!streamText) {
            controller.enqueue({ type: 'text-start', id: 'structured' });
            controller.enqueue({ type: 'text-delta', id: 'structured', delta: finalText(result, prepared.jsonSchema) });
            controller.enqueue({ type: 'text-end', id: 'structured' });
          }
          controller.enqueue({
            type: 'finish',
            finishReason: v3FinishReason(result.finishReason),
            usage: v3Usage(result.usage),
          });
        } catch (error) {
          close();
          controller.enqueue({ type: 'error', error });
        } finally {
          controller.close();
        }
      },
    });
    return { stream };
  }
}

export function isClaudeCodeModel(model: unknown): model is ClaudeCodeLanguageModel {
  return typeof model === 'object' && model !== null && (model as { [BRAND]?: boolean })[BRAND] === true;
}

export function createClaudeCodeModel(modelId: string, oauthToken?: string, configDir?: string): ClaudeCodeLanguageModel {
  return new ClaudeCodeLanguageModel(modelId, runClaudeCode, oauthToken, configDir);
}

function finalText(result: ClaudeCodeRunResult, jsonSchema: Record<string, unknown> | undefined): string {
  if (jsonSchema && result.structuredOutput !== undefined) return JSON.stringify(result.structuredOutput);
  return result.text;
}

function splitKey(key: string): [string, string] {
  const index = key.indexOf(':');
  return [key.slice(0, index), key.slice(index + 1)];
}

export function v3Usage(usage: CliUsage): LanguageModelV3Usage {
  return {
    inputTokens: { total: usage.inputTokens, noCache: undefined, cacheRead: usage.cacheReadTokens, cacheWrite: usage.cacheCreationTokens },
    outputTokens: { total: usage.outputTokens, text: undefined, reasoning: undefined },
  };
}

export function v3FinishReason(reason: string): LanguageModelV3FinishReason {
  const unified: LanguageModelV3FinishReason['unified'] =
    reason === 'stop' || reason === 'length' || reason === 'content-filter' || reason === 'tool-calls'
      ? reason
      : 'other';
  return { unified, raw: reason };
}
