import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchProviderUsage } from './usage-api-client';
import type { ApiProvider } from '../../../shared/utils/provider-detection';

const log = { debugLog: vi.fn(), traceLog: vi.fn() };

function jsonResponse(status: number, body: unknown, ok = status >= 200 && status < 300) {
  return {
    ok,
    status,
    statusText: String(status),
    headers: { get: () => 'application/json' },
    json: async () => body
  } as unknown as Response;
}

const anthropicBody = {
  five_hour: { utilization: 42, resets_at: '2030-01-01T00:00:00Z' },
  seven_day: { utilization: 10, resets_at: '2030-01-05T00:00:00Z' }
};

function run(provider: ApiProvider = 'anthropic', baseUrl = 'https://api.anthropic.com') {
  return fetchProviderUsage({
    credential: 'tok-123',
    provider,
    baseUrl,
    profileId: 'p1',
    profileName: 'P1',
    profileEmail: 'a@b.c',
    log
  });
}

describe('fetchProviderUsage', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns ok with normalized usage on 200', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, anthropicBody));
    const outcome = await run();
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') {
      expect(outcome.usage.profileId).toBe('p1');
      expect(outcome.usage.sessionPercent).toBe(42);
    }
  });

  it('returns rate-limited on 429', async () => {
    fetchMock.mockResolvedValue(jsonResponse(429, {}));
    expect(await run()).toEqual({ kind: 'rate-limited' });
  });

  it.each([401, 403])('throws auth failure with statusCode on %i', async (status) => {
    fetchMock.mockResolvedValue(jsonResponse(status, {}));
    await expect(run()).rejects.toMatchObject({
      message: `API Auth Failure: ${status} (anthropic)`,
      statusCode: status
    });
  });

  it('throws when the error body indicates an auth failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: 'Invalid token supplied' }));
    await expect(run()).rejects.toMatchObject({ statusCode: 500, detectedInBody: true });
  });

  it('returns failed with cooldown on non-auth 500', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: 'boom' }));
    expect(await run()).toEqual({ kind: 'failed', cooldown: true });
  });

  it('returns failed with cooldown when the error body is unparseable', async () => {
    fetchMock.mockResolvedValue({
      ...jsonResponse(500, {}),
      json: async () => {
        throw new Error('bad json');
      }
    });
    expect(await run()).toEqual({ kind: 'failed', cooldown: true });
  });

  it('blocks unauthorized domains without cooldown and without fetching', async () => {
    const outcome = await run('anthropic', 'https://evil.example.com');
    expect(outcome.kind === 'failed' || outcome.kind === 'unsupported').toBe(true);
    if (outcome.kind === 'failed') expect(outcome.cooldown).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns unsupported for an unknown provider', async () => {
    expect(await run('unknown' as ApiProvider, 'https://example.com')).toEqual({ kind: 'unsupported' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends Bearer auth, content type and anthropic extras', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, anthropicBody));
    await run();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer tok-123',
      'Content-Type': 'application/json',
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
      'anthropic-version': '2023-06-01'
    });
  });

  it('sends only generic headers for zai', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { limits: [] } }));
    await run('zai', 'https://api.z.ai/api/anthropic');
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer tok-123');
    expect(init.headers['anthropic-beta']).toBeUndefined();
  });

  it.each([401, 403])('throws an error with statusCode %i for openrouter auth failure', async (status) => {
    fetchMock.mockResolvedValue(jsonResponse(status, {}));
    await expect(run('openrouter', 'https://openrouter.ai/api')).rejects.toMatchObject({ statusCode: status });
  });
});
