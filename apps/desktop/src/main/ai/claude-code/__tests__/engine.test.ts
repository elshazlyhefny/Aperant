import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tool } from 'ai';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod/v3';

import { classifyError } from '../../session/error-classifier';
import type { ClaudeCodePart } from '../cli-events';
import { runClaudeCode } from '../engine';

/**
 * A fake `claude`: records what it was given, then plays back a scenario.
 * Real spawning, real stdin/stdout, no subscription used.
 */
const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'));
const fake = join(dir, 'claude');
writeFileSync(
  fake,
  `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
let stdin = '';
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  const sysFile = flag('--system-prompt-file');
  const mcp = flag('--mcp-config');
  const record = {
    args, stdin, cwd: process.cwd(),
    apiKey: process.env.ANTHROPIC_API_KEY ?? null,
    sysFile, system: sysFile ? fs.readFileSync(sysFile, 'utf8') : null,
    sysMode: sysFile ? (fs.statSync(sysFile).mode & 0o777) : null,
    mcp, mcpBody: mcp && mcp.startsWith('/') ? fs.readFileSync(mcp, 'utf8') : mcp,
    mcpMode: mcp && mcp.startsWith('/') ? (fs.statSync(mcp).mode & 0o777) : null,
  };
  fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify(record));
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  const step = (id, text, stop) => {
    out({ type: 'stream_event', event: { type: 'message_start', message: { id, usage: { input_tokens: 3, output_tokens: 1 } } } });
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
    out({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 4 } } });
    out({ type: 'stream_event', event: { type: 'message_stop' } });
  };
  switch (process.env.FAKE_MODE) {
    case 'ok':
      out({ type: 'system', subtype: 'init' });
      process.stdout.write('not json noise\\n');
      step('m1', 'Hello', 'end_turn');
      out({ type: 'result', subtype: 'success', is_error: false, result: 'Hello', structured_output: { ok: true } });
      process.exit(0);
    case 'error429':
      out({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: 'Error' });
      process.exit(1);
    case 'crash':
      process.stderr.write('segfault-ish failure');
      process.exit(3);
    case 'loop':
      step('m1', 'one', 'tool_use');
      step('m2', 'two', 'tool_use');
      out({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm3', usage: {} } } });
      setInterval(() => undefined, 1000);
      break;
    case 'hang':
      out({ type: 'system', subtype: 'init' });
      setInterval(() => undefined, 1000);
      break;
  }
});
`,
);
chmodSync(fake, 0o755);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
function scenario(mode: string) {
  const record = join(dir, `record-${++counter}.json`);
  const env = { ...process.env, FAKE_MODE: mode, FAKE_RECORD: record, ANTHROPIC_API_KEY: 'sk-ant-api-should-not-leak' };
  return { env, read: () => JSON.parse(readFileSync(record, 'utf8')) };
}

describe('runClaudeCode', () => {
  it('runs the CLI isolated, feeds the prompt on stdin and returns the result', async () => {
    const { env, read } = scenario('ok');
    const parts: ClaudeCodePart[] = [];
    const result = await runClaudeCode({
      modelId: 'claude-opus-5-5',
      system: 'SYSTEM PROMPT',
      prompt: 'Do the task.',
      cwd: dir,
      binaryPath: fake,
      env,
      onPart: (p) => parts.push(p),
    });

    expect(result).toMatchObject({ text: 'Hello', structuredOutput: { ok: true }, finishReason: 'stop', stoppedEarly: false });
    expect(result.steps).toHaveLength(1);
    expect(parts.filter((p) => p.type !== 'keepalive').map((p) => p.type)).toEqual(['start-step', 'text-delta', 'finish-step']);

    const rec = read();
    expect(rec.stdin).toBe('Do the task.');
    expect(rec.cwd).toBe(dir);
    expect(rec.apiKey).toBeNull();
    expect(rec.system).toBe('SYSTEM PROMPT');
    expect(rec.sysMode).toBe(0o600);
    expect(rec.mcpBody).toBe('{"mcpServers":{}}');
    expect(rec.args).toContain('--strict-mcp-config');
    expect(rec.args).not.toContain('--allowedTools');
    // Temporary files are removed afterwards.
    expect(existsSync(rec.sysFile)).toBe(false);
  });

  it('starts the tool bridge and hands the CLI a private config naming it', async () => {
    const { env, read } = scenario('ok');
    const tools = {
      Read: tool({ description: 'r', inputSchema: z.object({ p: z.string() }), execute: async () => 'x' }),
    };
    await runClaudeCode({ modelId: 'm', prompt: 'p', tools, binaryPath: fake, env, onPart: () => undefined });

    const rec = read();
    expect(rec.mcpMode).toBe(0o600);
    const config = JSON.parse(rec.mcpBody);
    const server = config.mcpServers.aperant;
    expect(server.type).toBe('http');
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(server.headers.Authorization).toMatch(/^Bearer [0-9a-f]{64}$/);
    expect(rec.args).toContain('--allowedTools');
    expect(existsSync(rec.mcp)).toBe(false);
    // The bridge is closed with the run.
    await expect(fetch(server.url, { method: 'POST' })).rejects.toThrow();
  });

  it('throws a rate-limit error the session classifier recognises', async () => {
    const { env } = scenario('error429');
    const error = await runClaudeCode({ modelId: 'm', prompt: 'p', binaryPath: fake, env, onPart: () => undefined }).catch((e) => e);
    expect(classifyError(error).outcome).toBe('rate_limited');
  });

  it('reports a crash with its exit code and stderr', async () => {
    const { env } = scenario('crash');
    await expect(runClaudeCode({ modelId: 'm', prompt: 'p', binaryPath: fake, env, onPart: () => undefined })).rejects.toThrow(
      /exit code 3.*segfault-ish failure/,
    );
  });

  it('stops before a further model request once the stop condition holds', async () => {
    const { env } = scenario('loop');
    const seen: number[] = [];
    const result = await runClaudeCode({
      modelId: 'm',
      prompt: 'p',
      binaryPath: fake,
      env,
      shouldStop: (steps) => {
        seen.push(steps.length);
        return steps.length >= 2;
      },
      onPart: () => undefined,
    });
    expect(seen).toEqual([1, 2]);
    expect(result.stoppedEarly).toBe(true);
    expect(result.finishReason).toBe('length');
    expect(result.steps.map((s) => s.text)).toEqual(['one', 'two']);
  }, 15_000);

  it('kills the CLI and throws AbortError when cancelled', async () => {
    const { env } = scenario('hang');
    const controller = new AbortController();
    const run = runClaudeCode({ modelId: 'm', prompt: 'p', binaryPath: fake, env, abortSignal: controller.signal, onPart: () => undefined });
    setTimeout(() => controller.abort(), 300);
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  }, 15_000);

  it('says how to fix a missing CLI', async () => {
    await expect(
      runClaudeCode({ modelId: 'm', prompt: 'p', env: { PATH: '', APERANT_CLAUDE_PATH: join(dir, 'missing') }, onPart: () => undefined }),
    ).rejects.toThrow(/Claude Code CLI not found/);
  });
});
