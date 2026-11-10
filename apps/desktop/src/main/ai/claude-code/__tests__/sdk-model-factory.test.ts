import { Output, generateText as aiGenerateText, stepCountIs, streamText as aiStreamText, tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod/v3';

import { createProvider, usesClaudeCodeEngine } from '../../providers/factory';
import { SupportedProvider } from '../../providers/types';
import { emptyUsage, type ClaudeCodePart, type CliStep } from '../cli-events';
import type { ClaudeCodeRunOptions, ClaudeCodeRunResult } from '../engine';
import { ClaudeCodeLanguageModel, isClaudeCodeModel } from '../model';
import { generateText, streamText } from '../sdk';
import { TokenBudgetGuard } from '../../session/token-budget';

function step(text: string, finishReason = 'tool-calls', toolName = 'Read'): CliStep {
  return { text, finishReason, toolCalls: [{ toolCallId: `id-${text}`, toolName }], usage: { ...emptyUsage(), inputTokens: 10, outputTokens: 2, totalTokens: 12, promptTokens: 10, completionTokens: 2 } };
}

/** A fake engine that records its options, plays parts, and can call the given tools. */
function fakeEngine(script: {
  parts?: ClaudeCodePart[];
  result?: Partial<ClaudeCodeRunResult>;
  error?: Error;
  callTool?: { name: string; input: unknown };
}) {
  const calls: ClaudeCodeRunOptions[] = [];
  const run = async (options: ClaudeCodeRunOptions): Promise<ClaudeCodeRunResult> => {
    calls.push(options);
    for (const part of script.parts ?? []) options.onPart(part);
    if (script.callTool && options.tools) {
      const t = options.tools[script.callTool.name];
      await t.execute?.(script.callTool.input as never, { toolCallId: 't1', messages: [] });
    }
    if (script.error) throw script.error;
    return { text: 'final', finishReason: 'stop', usage: emptyUsage(), steps: [], stoppedEarly: false, ...script.result };
  };
  return { run, calls };
}

const readTool = (log: string[]) =>
  tool({ description: 'Read', inputSchema: z.object({ file_path: z.string() }), execute: async ({ file_path }) => { log.push(file_path); return 'x'; } });

describe('drop-in streamText with a Claude Code model and tools', () => {
  it('runs the engine and exposes fullStream, text, usage and step callbacks', async () => {
    const stepDone = step('working');
    const { run, calls } = fakeEngine({
      parts: [
        { type: 'keepalive' },
        { type: 'start-step' },
        { type: 'text-delta', id: 'm1', text: 'working' },
        { type: 'reasoning-delta', id: 'm1', delta: 'hmm' },
        { type: 'tool-call', toolCallId: 't1', toolName: 'Read', input: { file_path: 'a' } },
        { type: 'tool-result', toolCallId: 't1', toolName: 'Read', input: { file_path: 'a' }, output: 'x' },
        { type: 'finish-step', finishReason: 'tool-calls', usage: stepDone.usage, toolCalls: stepDone.toolCalls, text: 'working' },
      ],
      result: { text: 'All done', usage: { ...emptyUsage(), inputTokens: 10, outputTokens: 2, totalTokens: 12 }, steps: [stepDone] },
    });
    const model = new ClaudeCodeLanguageModel('claude-opus-5-5', run);
    const stepCalls: string[][] = [];
    const stepTexts: string[] = [];

    const result = streamText({
      model,
      system: 'SYS',
      messages: [{ role: 'user', content: 'Go' }],
      tools: { Read: readTool([]) },
      stopWhen: stepCountIs(5),
      providerOptions: { anthropic: { thinking: { type: 'enabled', budgetTokens: 16384 } }, 'claude-code': { cwd: '/work/tree' } },
      onStepFinish: ({ toolCalls, text }) => { stepCalls.push(toolCalls.map((c) => c.toolName)); stepTexts.push(text); },
    });

    const parts: Array<Record<string, unknown>> = [];
    for await (const part of result.fullStream) parts.push(part as unknown as Record<string, unknown>);

    expect(parts.map((p) => p.type)).toEqual([
      'start', 'raw', 'start-step', 'text-delta', 'reasoning-delta', 'tool-call', 'tool-result', 'finish-step', 'finish',
    ]);
    expect(parts[3]).toMatchObject({ text: 'working' });
    expect(parts[4]).toMatchObject({ delta: 'hmm' });
    expect(parts[5]).toMatchObject({ toolName: 'Read', input: { file_path: 'a' } });
    expect(await result.text).toBe('All done');
    expect(await result.totalUsage).toMatchObject({ inputTokens: 10, outputTokens: 2 });
    expect(stepCalls).toEqual([['Read']]);
    expect(stepTexts).toEqual(['working']);

    const options = calls[0];
    expect(options.system).toBe('SYS');
    expect(options.prompt).toBe('Go');
    expect(options.modelId).toBe('claude-opus-5-5');
    expect(options.cwd).toBe('/work/tree');
    expect(options.effort).toBe('high');
    expect(Object.keys(options.tools ?? {})).toEqual(['Read']);
  });

  it('turns stopWhen into a stop check over finished steps', async () => {
    const { run, calls } = fakeEngine({});
    const model = new ClaudeCodeLanguageModel('m', run);
    const result = streamText({ model, prompt: 'Go', tools: { Read: readTool([]) }, stopWhen: stepCountIs(3) });
    for await (const _ of result.fullStream) { /* drain */ }
    const shouldStop = calls[0].shouldStop;
    expect(shouldStop).toBeTypeOf('function');
    // stepCountIs is synchronous, so the answer must be too (not a promise).
    expect(shouldStop?.([step('a'), step('b')])).toBe(false);
    expect(shouldStop?.([step('a'), step('b'), step('c')])).toBe(true);
  });

  it('ends the run when a stopWhen array containing a token budget condition is crossed', async () => {
    const { run, calls } = fakeEngine({});
    const model = new ClaudeCodeLanguageModel('m', run);
    const guard = new TokenBudgetGuard({ limit: 20, readSpentTokens: () => 0 });
    const result = streamText({
      model,
      prompt: 'Go',
      tools: { Read: readTool([]) },
      stopWhen: [stepCountIs(50), guard.buildStopCondition()],
    });
    for await (const _ of result.fullStream) { /* drain */ }
    const shouldStop = calls[0].shouldStop;
    // Each step() reports 12 tokens: one step is under 20, two cross it.
    expect(shouldStop?.([step('a')])).toBe(false);
    expect(shouldStop?.([step('a'), step('b')])).toBe(true);
  });

  it('throws the engine error from fullStream so callers can classify it', async () => {
    const { run } = fakeEngine({ error: new Error('Claude Code CLI: 429 rate limit reached') });
    const model = new ClaudeCodeLanguageModel('m', run);
    const result = streamText({ model, prompt: 'Go', tools: { Read: readTool([]) } });
    await expect(async () => {
      for await (const _ of result.fullStream) { /* drain */ }
    }).rejects.toThrow(/429 rate limit/);
    await expect(result.text).rejects.toThrow(/429/);
  });

  it('parses structured output through the Output definition', async () => {
    const { run, calls } = fakeEngine({ result: { structuredOutput: { word: 'MANGO' }, text: '{"word":"MANGO"}' } });
    const model = new ClaudeCodeLanguageModel('m', run);
    const result = streamText({
      model,
      prompt: 'Go',
      tools: { Read: readTool([]) },
      output: Output.object({ schema: z.object({ word: z.string() }) }),
    });
    for await (const _ of result.fullStream) { /* drain */ }
    expect(await result.output).toEqual({ word: 'MANGO' });
    expect(calls[0].jsonSchema).toMatchObject({ type: 'object', properties: { word: { type: 'string' } } });
  });

  it('drop-in generateText returns text, steps and output', async () => {
    const log: string[] = [];
    const { run } = fakeEngine({ callTool: { name: 'Read', input: { file_path: 'b' } }, result: { text: 'ok', steps: [step('s1'), step('s2', 'stop')] } });
    const model = new ClaudeCodeLanguageModel('m', run);
    const result = await generateText({ model, prompt: 'Go', tools: { Read: readTool(log) }, stopWhen: stepCountIs(9) });
    expect(result.text).toBe('ok');
    expect(result.steps).toHaveLength(2);
    expect(log).toEqual(['b']);
  });
});

describe('drop-ins leave every other call to the AI SDK', () => {
  it('passes a Claude Code model WITHOUT tools to the AI SDK, which uses the model itself', async () => {
    const { run, calls } = fakeEngine({ result: { text: 'blue' } });
    const model = new ClaudeCodeLanguageModel('m', run);
    const result = await generateText({ model, system: 'One word.', prompt: 'Sky colour?' });
    expect(result.text).toBe('blue');
    expect(calls[0].tools).toBeUndefined();
    expect(calls[0].system).toBe('One word.');
    // Only the AI SDK builds response messages; the engine path returns none.
    expect(result.response.messages.length).toBeGreaterThan(0);
  });

  it('leaves any other model with tools (e.g. Codex) entirely to the AI SDK', async () => {
    const usage = {
      inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: undefined, reasoning: undefined },
    };
    const model = new MockLanguageModelV3({
      doGenerate: { content: [{ type: 'text', text: 'from the API' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] },
    });
    const result = await generateText({ model, prompt: 'Go', tools: { Read: readTool([]) } });
    expect(result.text).toBe('from the API');
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(model.doGenerateCalls[0].tools?.map((t) => t.name)).toEqual(['Read']);
  });

  it('keeps the drop-in signatures identical to the AI SDK', () => {
    expectTypeOf(streamText).toEqualTypeOf<typeof aiStreamText>();
    expectTypeOf(generateText).toEqualTypeOf<typeof aiGenerateText>();
  });
});

describe('ClaudeCodeLanguageModel', () => {
  it('refuses tools given directly, so a caller that bypassed the drop-ins fails loudly', async () => {
    const { run, calls } = fakeEngine({});
    const model = new ClaudeCodeLanguageModel('m', run);
    await expect(
      aiGenerateText({ model, prompt: 'Go', tools: { Read: readTool([]) } }),
    ).rejects.toThrow(/outside the Claude Code engine/);
    expect(calls).toHaveLength(0);
  });

  it('streams text through the AI SDK', async () => {
    const { run } = fakeEngine({
      parts: [{ type: 'text-delta', id: 'm1', text: 'Hel' }, { type: 'text-delta', id: 'm1', text: 'lo' }],
      result: { text: 'Hello' },
    });
    const model = new ClaudeCodeLanguageModel('m', run);
    const result = aiStreamText({ model, prompt: 'Hi' });
    expect(await result.text).toBe('Hello');
  });

  it('returns structured output as the single JSON text', async () => {
    const { run, calls } = fakeEngine({
      parts: [{ type: 'text-delta', id: 'm1', text: 'prose that would break JSON' }],
      result: { text: 'ignored', structuredOutput: { city: 'Paris' } },
    });
    const model = new ClaudeCodeLanguageModel('m', run);
    const result = await aiGenerateText({ model, prompt: 'Capital?', output: Output.object({ schema: z.object({ city: z.string() }) }) });
    expect(result.output).toEqual({ city: 'Paris' });
    expect(calls[0].jsonSchema).toBeDefined();

    const streamed = aiStreamText({ model, prompt: 'Capital?', output: Output.object({ schema: z.object({ city: z.string() }) }) });
    expect(await streamed.output).toEqual({ city: 'Paris' });
  });
});

describe('the selected Claude account', () => {
  it('is handed to the engine on every call, and never exposed on the model', async () => {
    const { run, calls } = fakeEngine({ result: { text: 'ok' } });
    const model = new ClaudeCodeLanguageModel('m', run, 'sk-ant-oat01-secret');
    await aiGenerateText({ model, prompt: 'Hi' });
    expect(calls[0].oauthToken).toBe('sk-ant-oat01-secret');
    expect(JSON.stringify(model)).not.toContain('secret');
    expect(Object.values(model)).not.toContain('sk-ant-oat01-secret');
  });
});

describe('provider factory', () => {
  const oauth = { provider: SupportedProvider.Anthropic, apiKey: 'sk-ant-oat01-abc' };

  it('sends a Claude subscription through Claude Code and nothing else', () => {
    expect(usesClaudeCodeEngine(oauth, {})).toBe(true);
    expect(usesClaudeCodeEngine({ ...oauth, apiKey: 'sk-ant-api03-abc' }, {})).toBe(false);
    expect(usesClaudeCodeEngine({ ...oauth, apiKey: undefined }, {})).toBe(false);
    expect(usesClaudeCodeEngine({ provider: SupportedProvider.OpenAI, apiKey: 'sk-ant-oat01-abc' }, {})).toBe(false);
    expect(usesClaudeCodeEngine(oauth, { APERANT_CLAUDE_ENGINE: 'api' })).toBe(false);
  });

  it('creates a Claude Code model for a subscription and an API model for a key', () => {
    const sub = createProvider({ config: oauth, modelId: 'claude-opus-5-5' });
    expect(isClaudeCodeModel(sub)).toBe(true);
    expect((sub as ClaudeCodeLanguageModel).modelId).toBe('claude-opus-5-5');
    const key = createProvider({ config: { ...oauth, apiKey: 'sk-ant-api03-abc' }, modelId: 'claude-opus-5-5' });
    expect(isClaudeCodeModel(key)).toBe(false);
  });
});
