import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../claude-profile/token-refresh', () => ({
  ensureValidToken: vi.fn(async () => ({ token: null })),
  reactiveTokenRefresh: vi.fn(async () => ({ token: null })),
}));

import { NO_CREDENTIALS_MESSAGE, resolveHeadlessAuth } from '../auth';

const VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const v of VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
});
afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

describe('resolveHeadlessAuth', () => {
  it('resolves from the environment', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api-test';
    const r = await resolveHeadlessAuth('claude-sonnet-4-5', null, {});
    expect(r.provider).toBe('anthropic');
    expect(r.auth.apiKey).toBe('sk-ant-api-test');
  });

  it('resolves another provider from its env var', async () => {
    process.env.OPENAI_API_KEY = 'sk-openai';
    const r = await resolveHeadlessAuth('gpt-5', null, {});
    expect(r.provider).toBe('openai');
    expect(r.auth.apiKey).toBe('sk-openai');
  });

  it('resolves from the provider queue config', async () => {
    const config = {
      providerAccounts: [
        { id: 'acc1', provider: 'anthropic', authType: 'api-key', apiKey: 'queue-key', isActive: true, name: 'a', billingModel: 'pay-per-use' },
      ],
      globalPriorityOrder: ['acc1'],
    } as never;
    const r = await resolveHeadlessAuth('claude-sonnet-4-5', null, config);
    expect(r.auth.apiKey).toBe('queue-key');
    expect(r.provider).toBe('anthropic');
  });

  it('uses CLAUDE_CODE_OAUTH_TOKEN when no API key is set', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-token';
    const r = await resolveHeadlessAuth('claude-sonnet-4-5', null, {});
    expect(r.auth.apiKey).toBe('sk-ant-oat01-token');
  });

  it('prefers ANTHROPIC_API_KEY over the OAuth token', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-token';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api-key';
    const r = await resolveHeadlessAuth('claude-sonnet-4-5', null, {});
    expect(r.auth.apiKey).toBe('sk-ant-api-key');
  });

  it('throws naming the env vars when nothing is found', async () => {
    await expect(resolveHeadlessAuth('claude-sonnet-4-5', null, {})).rejects.toThrow(NO_CREDENTIALS_MESSAGE);
    expect(NO_CREDENTIALS_MESSAGE).toContain('ANTHROPIC_API_KEY');
    expect(NO_CREDENTIALS_MESSAGE).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });
});
