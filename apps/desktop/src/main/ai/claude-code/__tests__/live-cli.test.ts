/**
 * Live test against the installed Claude Code CLI. Skipped unless
 * APERANT_LIVE_CLAUDE=1, because it uses the signed-in subscription.
 *
 *   APERANT_LIVE_CLAUDE=1 npx vitest run src/main/ai/claude-code/__tests__/live-cli.test.ts
 */

import { Output, generateText as aiGenerateText, stepCountIs, tool } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v3';

import { createClaudeCodeModel } from '../model';
import { streamText } from '../sdk';

const live = process.env.APERANT_LIVE_CLAUDE === '1';
const MODEL = process.env.APERANT_LIVE_MODEL ?? 'claude-sonnet-5-5';

describe.skipIf(!live)('Claude Code CLI (live)', () => {
  it('calls a bridged tool and returns structured output', async () => {
    const calls: unknown[] = [];
    const lookup = tool({
      description: 'Look up the secret word stored under a key.',
      inputSchema: z.object({ key: z.string() }),
      execute: async ({ key }) => {
        calls.push(key);
        return `The secret word for ${key} is MANGO.`;
      },
    });

    const result = streamText({
      model: createClaudeCodeModel(MODEL),
      system: 'You are a precise agent. Use tools when asked.',
      messages: [{ role: 'user', content: 'Use the Lookup tool with key "fruit", then answer with the secret word.' }],
      tools: { Lookup: lookup },
      stopWhen: stepCountIs(10),
      output: Output.object({ schema: z.object({ word: z.string() }) }),
    });

    const types: string[] = [];
    for await (const part of result.fullStream) types.push(part.type);

    expect(calls).toEqual(['fruit']);
    expect(types).toContain('tool-call');
    expect(types).toContain('tool-result');
    expect(types).toContain('finish-step');
    const output = (await result.output) as { word: string };
    expect(output.word.toUpperCase()).toBe('MANGO');
  }, 180_000);

  it('answers a plain request through the AI SDK with no tools', async () => {
    const result = await aiGenerateText({
      model: createClaudeCodeModel(MODEL),
      system: 'Answer with one word.',
      prompt: 'What colour is a clear daytime sky?',
    });
    expect(result.text.toLowerCase()).toContain('blue');
  }, 120_000);
});
