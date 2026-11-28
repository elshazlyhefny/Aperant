import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../claude-profile/token-refresh', () => ({
  ensureValidToken: vi.fn(async () => ({ token: null })),
  reactiveTokenRefresh: vi.fn(async () => ({ token: null })),
}));

import { NO_CREDENTIALS_MESSAGE, resolveHeadlessAuth } from '../auth';
import type { HeadlessConfig } from '../config';
import { clearHeadlessRateLimitMemory, recordHeadlessRateLimit } from '../rate-limit-state';

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

  it('resolves an environment key without desktop secure storage', async () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'google-env-fixture';

    const r = await resolveHeadlessAuth('gemini-2.5-pro', null, {});

    expect(r).toMatchObject({ provider: 'google', auth: { apiKey: 'google-env-fixture', source: 'environment' } });
  });

  it('ignores desktop ciphertext in providerAccounts passed via --config', async () => {
    process.env.OPENAI_API_KEY = 'openai-env-fixture';
    const account = {
      id: 'desktop-account',
      name: 'Desktop account',
      provider: 'openai',
      authType: 'api-key',
      apiKey: 'aperant-secret:v1:YQ==',
      billingModel: 'pay-per-use',
      isActive: true,
      createdAt: 0,
      updatedAt: 0,
    } as const;
    const config: HeadlessConfig = { providerAccounts: [account], globalPriorityOrder: [account.id] };

    const r = await resolveHeadlessAuth('gpt-5', null, config);

    expect(r).toMatchObject({ provider: 'openai', auth: { apiKey: 'openai-env-fixture', source: 'environment' } });
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

// zeenha fork: an account with a recorded headless rate limit is skipped until its reset.
describe('resolveHeadlessAuth with recorded rate limits', () => {
  let projectDir: string;
  const config = {
    providerAccounts: [
      { id: 'acc1', provider: 'anthropic', authType: 'api-key', apiKey: 'key-one', isActive: true, name: 'a', billingModel: 'subscription' },
      { id: 'acc2', provider: 'anthropic', authType: 'api-key', apiKey: 'key-two', isActive: true, name: 'b', billingModel: 'subscription' },
    ],
    globalPriorityOrder: ['acc1', 'acc2'],
  } as never as HeadlessConfig;

  beforeEach(() => {
    projectDir = mkdtempSync(path.join(tmpdir(), 'headless-auth-rl-'));
    clearHeadlessRateLimitMemory();
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('skips the limited account until its reset, then uses it again', async () => {
    const first = await resolveHeadlessAuth('claude-sonnet-4-5', null, config, projectDir);
    expect(first).toMatchObject({ accountId: 'acc1', auth: { apiKey: 'key-one' } });

    const reset = Date.now() + 3_600_000;
    await recordHeadlessRateLimit(projectDir, 'acc1', reset);
    clearHeadlessRateLimitMemory(); // the next run is a new process: only the file remains

    const limited = await resolveHeadlessAuth('claude-sonnet-4-5', null, config, projectDir);
    expect(limited).toMatchObject({ accountId: 'acc2', auth: { apiKey: 'key-two' } });

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(reset + 1);
    const afterReset = await resolveHeadlessAuth('claude-sonnet-4-5', null, config, projectDir);
    expect(afterReset).toMatchObject({ accountId: 'acc1', auth: { apiKey: 'key-one' } });
  });

  it('ignores recorded limits when no project is given', async () => {
    await recordHeadlessRateLimit(projectDir, 'acc1', Date.now() + 3_600_000);
    const r = await resolveHeadlessAuth('claude-sonnet-4-5', null, config);
    expect(r.accountId).toBe('acc1');
  });

  it('names the reset when every account is limited and no other credential exists', async () => {
    const reset = Date.now() + 3_600_000;
    await recordHeadlessRateLimit(projectDir, 'acc1', reset);
    await recordHeadlessRateLimit(projectDir, 'acc2', reset + 60_000);
    await expect(resolveHeadlessAuth('claude-sonnet-4-5', null, config, projectDir))
      .rejects.toThrow(new Date(reset).toISOString());
  });
});
