import { describe, expect, it } from 'vitest';

import { classifyError } from '../../session/error-classifier';
import {
  buildClaudeArgs,
  buildClaudeEnv,
  effortFromProviderOptions,
  renderPrompt,
  systemFromMessages,
} from '../cli-args';
import { type ClaudeCodePart, cliFailureError, createCliEventParser, mapStopReason } from '../cli-events';

function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

describe('buildClaudeArgs', () => {
  const base = { modelId: 'claude-opus-5-5', mcpConfig: '/tmp/mcp.json', hasTools: true };

  it('disables every built-in tool and every outside configuration', () => {
    const args = buildClaudeArgs(base);
    expect(argValue(args, '--tools')).toBe('');
    expect(args).toContain('--strict-mcp-config');
    expect(argValue(args, '--mcp-config')).toBe('/tmp/mcp.json');
    expect(argValue(args, '--setting-sources')).toBe('');
    expect(argValue(args, '--permission-mode')).toBe('dontAsk');
    expect(args).toContain('--no-session-persistence');
    expect(args).toContain('--disable-slash-commands');
    expect(argValue(args, '--model')).toBe('claude-opus-5-5');
    expect(argValue(args, '--output-format')).toBe('stream-json');
  });

  it('allows exactly the bridged tools, and none when there are no tools', () => {
    expect(argValue(buildClaudeArgs(base), '--allowedTools')).toBe('mcp__aperant');
    expect(buildClaudeArgs({ ...base, hasTools: false })).not.toContain('--allowedTools');
  });

  it('passes the system prompt as a file, effort and a JSON schema', () => {
    const args = buildClaudeArgs({
      ...base,
      systemPromptFile: '/tmp/sys.txt',
      effort: 'high',
      jsonSchema: { type: 'object' },
    });
    expect(argValue(args, '--system-prompt-file')).toBe('/tmp/sys.txt');
    expect(args).not.toContain('--system-prompt');
    expect(argValue(args, '--effort')).toBe('high');
    expect(JSON.parse(argValue(args, '--json-schema') ?? '')).toEqual({ type: 'object' });
  });
});

describe('buildClaudeEnv', () => {
  it('removes API credentials so the subscription is always used', () => {
    const env = buildClaudeEnv({
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'sk-ant-api-x',
      ANTHROPIC_AUTH_TOKEN: 'tok',
      CLAUDECODE: '1',
      ELECTRON_RUN_AS_NODE: '1',
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.PATH).toBe('/bin');
    expect(env.MCP_TOOL_TIMEOUT).toBe('3600000');
  });

  it('removes other credential variables but keeps sign-in variables', () => {
    const env = buildClaudeEnv({
      PATH: '/bin',
      HOME: '/home/u',
      AWS_ACCESS_KEY_ID: 'a',
      AWS_SECRET_ACCESS_KEY: 'b',
      GITHUB_TOKEN: 'ghp',
      MY_SERVICE_SECRET: 's',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
      CLAUDE_CONFIG_DIR: '/cfg',
    });
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.MY_SERVICE_SECRET).toBeUndefined();
    expect(env.PATH).toBe('/bin');
    expect(env.HOME).toBe('/home/u');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/cfg');
  });
});

describe('effortFromProviderOptions', () => {
  it('maps Aperant thinking budgets to CLI effort levels', () => {
    const at = (budgetTokens: number) => effortFromProviderOptions({ anthropic: { thinking: { type: 'enabled', budgetTokens } } });
    expect(at(1024)).toBe('low');
    expect(at(4096)).toBe('medium');
    expect(at(16384)).toBe('high');
    expect(at(32768)).toBe('xhigh');
    expect(effortFromProviderOptions(undefined)).toBeUndefined();
    expect(effortFromProviderOptions({ openai: {} })).toBeUndefined();
  });
});

describe('renderPrompt', () => {
  it('passes a single user message through unchanged', () => {
    expect(renderPrompt([{ role: 'user', content: 'Build the feature.' }])).toBe('Build the feature.');
    expect(renderPrompt([{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }])).toBe('Hi');
  });

  it('writes a longer conversation as a transcript, tool turns included', () => {
    const text = renderPrompt([
      { role: 'system', content: 'ignored here' },
      { role: 'user', content: 'Read a file' },
      { role: 'assistant', content: [{ type: 'tool-call', toolName: 'Read', input: { file_path: 'a.ts' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolName: 'Read', output: { type: 'text', value: 'export {}' } }] },
    ]);
    expect(text).toContain('[user]\nRead a file');
    expect(text).toContain('[called tool Read with {"file_path":"a.ts"}]');
    expect(text).toContain('[tool Read returned: export {}]');
    expect(text).not.toContain('ignored here');
  });

  it('collects system messages separately', () => {
    expect(
      systemFromMessages([
        { role: 'system', content: 'A' },
        { role: 'user', content: 'x' },
        { role: 'system', content: 'B' },
      ]),
    ).toBe('A\n\nB');
  });
});

// A shortened recording of `claude -p --output-format stream-json --verbose --include-partial-messages`.
function recording(): unknown[] {
  return [
    { type: 'system', subtype: 'init', tools: ['mcp__aperant__Read'] },
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 1 } } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me read.' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Reading.' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'mcp__aperant__Read_3' } } },
    { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 25 } } },
    { type: 'stream_event', event: { type: 'message_stop' } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }] } },
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_2', usage: { input_tokens: 5, cache_read_input_tokens: 120, output_tokens: 1 } } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } } },
    { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } } },
    { type: 'stream_event', event: { type: 'message_stop' } },
    { type: 'result', subtype: 'success', is_error: false, result: 'Done.', stop_reason: 'end_turn' },
  ];
}

describe('createCliEventParser', () => {
  it('turns a recording into steps, deltas, usage and the final result', () => {
    const parts: ClaudeCodePart[] = [];
    const starts: number[] = [];
    const parser = createCliEventParser({
      onPart: (p) => parts.push(p),
      onStepStart: (steps) => starts.push(steps.length),
      aliases: new Map([['Read_3', 'mcp__context7__read']]),
    });
    for (const event of recording()) parser.handle(event);

    const content = parts.filter((p) => p.type !== 'keepalive');
    expect(content.map((p) => p.type)).toEqual([
      'start-step', 'reasoning-delta', 'text-delta', 'finish-step',
      'start-step', 'text-delta', 'finish-step',
    ]);
    expect(starts).toEqual([0, 1]);
    expect(parser.steps).toHaveLength(2);
    expect(parser.steps[0]).toMatchObject({
      text: 'Reading.',
      finishReason: 'tool-calls',
      toolCalls: [{ toolCallId: 'toolu_1', toolName: 'mcp__context7__read' }],
      usage: { inputTokens: 100, outputTokens: 25, promptTokens: 100, completionTokens: 25 },
    });
    expect(parser.steps[1].finishReason).toBe('stop');
    expect(parser.totalUsage).toMatchObject({ inputTokens: 225, outputTokens: 32, totalTokens: 257 });
    expect(parser.result).toMatchObject({ isError: false, subtype: 'success', text: 'Done.' });
    // Every protocol line keeps inactivity guards alive.
    expect(parts.filter((p) => p.type === 'keepalive')).toHaveLength(recording().length);
  });

  it('records structured output and closes an unfinished step at the result', () => {
    const parser = createCliEventParser({ onPart: () => undefined });
    parser.handle({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm', usage: {} } } });
    parser.handle({ type: 'result', subtype: 'success', is_error: false, result: '{"a":1}', structured_output: { a: 1 } });
    expect(parser.steps).toHaveLength(1);
    expect(parser.result?.structuredOutput).toEqual({ a: 1 });
  });

  it('ignores sub-agent events', () => {
    const parser = createCliEventParser({ onPart: () => undefined });
    parser.handle({ type: 'stream_event', parent_tool_use_id: 'toolu_x', event: { type: 'message_start', message: { id: 'sub' } } });
    parser.handle({ type: 'stream_event', parent_tool_use_id: 'toolu_x', event: { type: 'message_stop' } });
    expect(parser.steps).toHaveLength(0);
  });
});

describe('createCliEventParser cache usage', () => {
  it('splits cached input out of the total, across messages', () => {
    const parser = createCliEventParser({ onPart: () => undefined });
    const send = (event: Record<string, unknown>) => parser.handle({ type: 'stream_event', event });
    send({ type: 'message_start', message: { id: 'a', usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 1 } } });
    send({ type: 'message_stop' });
    send({ type: 'message_start', message: { id: 'b', usage: { input_tokens: 5, cache_read_input_tokens: 130, cache_creation_input_tokens: 0, output_tokens: 1 } } });
    send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 5, cache_read_input_tokens: 140, cache_creation_input_tokens: 2, output_tokens: 9 } });
    send({ type: 'message_stop' });
    expect(parser.totalUsage).toMatchObject({ inputTokens: 277, outputTokens: 10, cacheReadTokens: 240, cacheCreationTokens: 22 });
  });
});

describe('mapStopReason', () => {
  it('maps Anthropic stop reasons to AI SDK finish reasons', () => {
    expect(mapStopReason('end_turn')).toBe('stop');
    expect(mapStopReason('tool_use')).toBe('tool-calls');
    expect(mapStopReason('max_tokens')).toBe('length');
    expect(mapStopReason('something')).toBe('other');
  });
});

describe('cliFailureError', () => {
  const failed = (apiErrorStatus: number | null, text: string) => ({
    isError: true, subtype: 'error_during_execution', apiErrorStatus, text, stopReason: null,
  });

  it('is classified as a rate limit for a 429', () => {
    expect(classifyError(cliFailureError(failed(429, 'Error'), 1, '')).outcome).toBe('rate_limited');
    expect(classifyError(cliFailureError(failed(null, "You've hit your usage limit"), 1, '')).outcome).toBe('rate_limited');
  });

  it('is classified as an auth failure when the CLI is not signed in', () => {
    expect(classifyError(cliFailureError(failed(401, 'x'), 1, '')).outcome).toBe('auth_failure');
    expect(classifyError(cliFailureError(null, 1, 'Not logged in · Please run /login')).outcome).toBe('auth_failure');
  });

  it('keeps any other failure a plain error that names the cause', () => {
    const error = cliFailureError(null, 2, 'boom');
    expect(error.message).toContain('exit code 2');
    expect(error.message).toContain('boom');
    expect(classifyError(error).outcome).toBe('error');
  });
});
