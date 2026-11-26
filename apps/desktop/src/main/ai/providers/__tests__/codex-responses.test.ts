import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateText, Output } from 'ai';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CODEX_RESPONSES_URL } from '../codex-responses';
import { createProvider } from '../factory';
import { ensureValidOAuthToken } from '../oauth-fetch';

let directory: string;
let tokenFile: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'aperant-codex-'));
  tokenFile = join(directory, 'codex-auth.json');
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

it('adapts a legacy subscription model and decodes a structured response streamed without a content type', async () => {
  const claims = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url');
  await writeFile(tokenFile, JSON.stringify({ access_token: `header.${claims}.signature`, expires_at: Date.now() + 3_600_000 }));
  const response = {
    id: 'resp_test',
    created_at: Math.floor(Date.now() / 1000),
    model: 'gpt-6.2-sol',
    output: [{ id: 'msg_test', role: 'assistant', type: 'message', content: [{ type: 'output_text', text: '{"status":"OK"}', annotations: [] }] }],
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(new TextEncoder().encode(
    `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`,
  )));
  vi.stubGlobal('fetch', fetch);
  const model = createProvider({
    config: { provider: 'openai', oauthTokenFilePath: tokenFile, baseURL: 'https://example.com/v1' },
    modelId: 'gpt-5.3-codex',
    codexReasoningEffort: 'low',
  });

  const result = await generateText({
    model, system: 'Return the status.', prompt: 'What is the status?', maxOutputTokens: 100,
    output: Output.object({ schema: z.object({ status: z.string() }) }),
  });

  expect(result.output).toEqual({ status: 'OK' });
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe(CODEX_RESPONSES_URL);
  expect(new Headers(init?.headers).get('ChatGPT-Account-Id')).toBe('fixture-account');
  const request = JSON.parse(String(init?.body));
  expect(request).toMatchObject({ model: 'gpt-6.2-sol', instructions: 'Return the status.', store: false, stream: true, reasoning: { effort: 'low' } });
  expect(request.input).toEqual([expect.objectContaining({ role: 'user' })]);
  expect(request.include).toContain('reasoning.encrypted_content');
  expect(request).not.toHaveProperty('max_output_tokens');
});

it('refreshes a rotating token once for concurrent callers', async () => {
  await writeFile(tokenFile, JSON.stringify({ access_token: 'old', refresh_token: 'initial', expires_at: 0 }));
  const fetch = vi.fn(async () => Response.json({ access_token: 'fresh', refresh_token: 'rotated', expires_in: 3600 }));
  vi.stubGlobal('fetch', fetch);

  const tokens = await Promise.all([ensureValidOAuthToken(tokenFile), ensureValidOAuthToken(tokenFile)]);

  expect(tokens).toEqual(['fresh', 'fresh']);
  expect(fetch).toHaveBeenCalledTimes(1);
});
