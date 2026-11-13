import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  warn: vi.fn(),
  settings: undefined as Record<string, unknown> | undefined
}));
vi.mock('../app-logger', () => ({ appLog: { warn: mocks.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../settings-utils', () => ({ readSettingsFile: () => mocks.settings }));

import {
  buildWebhookPayload,
  dispatchTaskOutcomeWebhook,
  mapOutcomeToWebhookEvent,
  sendTestWebhook,
  sendWebhook,
  validateWebhookUrl
} from '../task-webhook';

const URL_OK = 'https://hooks.example.com/services/SECRET/PATH';
const noDelay = () => Promise.resolve();
const res = (status: number) => ({ status }) as Response;

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  mocks.warn.mockReset();
  mocks.settings = undefined;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('mapOutcomeToWebhookEvent', () => {
  it.each([
    ['error', undefined, 'failed'],
    ['human_review', 'completed', 'review_ready'],
    ['human_review', 'qa_rejected', 'blocked'],
    ['human_review', 'errors', 'blocked'],
    ['human_review', 'plan_review', null],
    ['human_review', 'stopped', null],
    ['in_progress', undefined, null],
    ['done', 'completed', null],
    ['pr_created', undefined, 'pr_opened']
  ])('%s/%s -> %s', (s, r, e) => {
    expect(mapOutcomeToWebhookEvent(s, r)).toBe(e);
  });
});

describe('validateWebhookUrl', () => {
  it.each([
    URL_OK,
    'http://localhost:3000/x',
    'http://127.0.0.1/x',
    'http://[::1]:8080/x'
  ])('accepts %s', (u) => expect(validateWebhookUrl(u).ok).toBe(true));

  it.each([
    '',
    'not a url',
    'http://example.com/x',
    'ftp://example.com/x',
    'https://user:pw@example.com/x',
    'https://user@example.com/x',
    `https://example.com/${'a'.repeat(2100)}`
  ])('rejects %s', (u) => expect(validateWebhookUrl(u).ok).toBe(false));
});

describe('buildWebhookPayload', () => {
  it('contains project, title, event and outcome', () => {
    const s = JSON.stringify(buildWebhookPayload({ projectName: 'Proj', taskTitle: 'My task', event: 'failed' }));
    expect(s).toContain('Proj');
    expect(s).toContain('My task');
    expect(s).toContain('Failed');
    expect(s).toContain('Error');
  });

  it('escapes mrkdwn and strips control chars, truncates', () => {
    const p = buildWebhookPayload({
      projectName: 'P',
      taskTitle: `<!channel> & <@U1>\u0007${'x'.repeat(500)}`,
      event: 'blocked'
    });
    const s = JSON.stringify(p);
    expect(s).not.toContain('<!channel>');
    expect(s).toContain('&lt;!channel&gt; &amp; &lt;@U1&gt;');
    expect(s).not.toContain('\\u0007');
    expect(s.length).toBeLessThan(1500);
  });

  it('does not include secrets from the environment, logs or paths', () => {
    process.env.WEBHOOK_TEST_SECRET = 'sk-fake-token-123';
    const s = JSON.stringify(buildWebhookPayload({ projectName: 'P', taskTitle: 'T', event: 'review_ready' }));
    for (const bad of ['sk-fake-token-123', 'WEBHOOK_TEST_SECRET', '/home/', 'stack trace']) {
      expect(s).not.toContain(bad);
    }
    delete process.env.WEBHOOK_TEST_SECRET;
  });
});

describe('buildWebhookPayload pr_opened', () => {
  const PR = 'https://github.com/o/r/pull/1';
  const build = (prUrl?: string, event: 'pr_opened' | 'failed' | 'review_ready' | 'blocked' = 'pr_opened') =>
    buildWebhookPayload({ projectName: 'P', taskTitle: 'T', event, prUrl });

  it('adds a View PR button and the url in the text for an https url', () => {
    const p = build(PR);
    const actions = (p.blocks as Array<{ type: string; elements?: Array<{ url?: string }> }>).find((b) => b.type === 'actions');
    expect(actions?.elements?.[0].url).toBe(PR);
    expect(p.text).toContain(PR);
  });

  it('labels the event and outcome', () => {
    const s = JSON.stringify(build(PR));
    expect(s).toContain('PR opened');
    expect(s).toContain('Awaiting review');
  });

  it.each([
    ['http', 'http://github.com/o/r/pull/1'],
    ['javascript', 'javascript:alert(1)'],
    ['credentials', 'https://user:pw@github.com/o/r/pull/1'],
    ['empty', ''],
    ['undefined', undefined]
  ])('has no actions block and no url for %s', (_n, url) => {
    const p = build(url);
    const s = JSON.stringify(p);
    expect((p.blocks as Array<{ type: string }>).some((b) => b.type === 'actions')).toBe(false);
    if (url) {
      expect(s).not.toContain(url);
      expect(s).not.toContain('pw@');
    }
  });

  it.each(['failed', 'review_ready', 'blocked'] as const)('ignores prUrl for %s', (event) => {
    const s = JSON.stringify(build(PR, event));
    expect(s).not.toContain(PR);
    expect(s).not.toContain('actions');
  });

  it('does not include secrets or paths', () => {
    process.env.WEBHOOK_TEST_SECRET = 'sk-fake-token-123';
    const s = JSON.stringify(build(PR));
    for (const bad of ['sk-fake-token-123', 'WEBHOOK_TEST_SECRET', '/home/', 'stack trace']) {
      expect(s).not.toContain(bad);
    }
    delete process.env.WEBHOOK_TEST_SECRET;
  });
});

describe('sendWebhook', () => {
  const payload = buildWebhookPayload({ projectName: 'P', taskTitle: 'T', event: 'failed' });

  it('succeeds on 2nd attempt', async () => {
    fetchMock.mockResolvedValueOnce(res(500)).mockResolvedValueOnce(res(200));
    expect(await sendWebhook(URL_OK, payload, { delay: noDelay })).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const init = fetchMock.mock.calls[0][1];
    expect(init.redirect).toBe('error');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('stops after 3 attempts on non-2xx', async () => {
    fetchMock.mockResolvedValue(res(404));
    expect(await sendWebhook(URL_OK, payload, { delay: noDelay })).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('never propagates a thrown fetch', async () => {
    fetchMock.mockRejectedValue(new TypeError('boom'));
    await expect(sendWebhook(URL_OK, payload, { delay: noDelay })).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('never logs the URL, body or secrets', async () => {
    fetchMock.mockRejectedValue(new Error(`failed for ${URL_OK}`));
    await sendWebhook(URL_OK, payload, { delay: noDelay, eventName: 'failed' });
    expect(mocks.warn).toHaveBeenCalledTimes(3);
    const logged = JSON.stringify(mocks.warn.mock.calls);
    expect(logged).not.toContain('SECRET');
    expect(logged).not.toContain('hooks.example.com');
    expect(logged).not.toContain('failed for');
  });
});

describe('dispatchTaskOutcomeWebhook', () => {
  const enabled = (over: Record<string, unknown> = {}) => ({
    webhook: { enabled: true, url: URL_OK, events: { reviewReady: true, failed: true, blocked: true, prOpened: false }, ...over }
  });
  const input = { status: 'error', projectName: 'P', taskTitle: 'T' };

  it('sends when enabled', async () => {
    mocks.settings = enabled();
    fetchMock.mockResolvedValue(res(200));
    dispatchTaskOutcomeWebhook(input);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it('sends pr_created with the PR url when prOpened is on', async () => {
    mocks.settings = enabled({ events: { reviewReady: true, failed: true, blocked: true, prOpened: true } });
    fetchMock.mockResolvedValue(res(200));
    dispatchTaskOutcomeWebhook({ status: 'pr_created', projectName: 'P', taskTitle: 'T', prUrl: 'https://github.com/o/r/pull/1' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0][1].body)).toContain('https://github.com/o/r/pull/1');
  });

  it.each([
    ['prOpened false', { reviewReady: true, failed: true, blocked: true, prOpened: false }],
    ['settings from an older version', { reviewReady: true, failed: true, blocked: true }]
  ])('sends nothing for pr_created when %s', async (_n, events) => {
    mocks.settings = enabled({ events });
    dispatchTaskOutcomeWebhook({ status: 'pr_created', projectName: 'P', taskTitle: 'T', prUrl: 'https://github.com/o/r/pull/1' });
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['disabled', () => ({ webhook: { enabled: false, url: URL_OK } }), input],
    ['no settings', () => undefined, input],
    ['event off', () => enabled({ events: { reviewReady: true, failed: false, blocked: true, prOpened: false } }), input],
    ['invalid url', () => enabled({ url: 'http://example.com' }), input],
    ['unmapped outcome', () => enabled(), { ...input, status: 'in_progress' }]
  ])('sends nothing when %s', async (_n, mk, inp) => {
    mocks.settings = mk() as Record<string, unknown> | undefined;
    dispatchTaskOutcomeWebhook(inp);
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not throw even if settings read throws', () => {
    Object.defineProperty(mocks, 'settings', { get() { throw new Error('x'); }, configurable: true });
    expect(() => dispatchTaskOutcomeWebhook(input)).not.toThrow();
    Object.defineProperty(mocks, 'settings', { value: undefined, writable: true, configurable: true });
  });
});

describe('sendTestWebhook', () => {
  it('rejects invalid urls without fetching', async () => {
    expect(await sendTestWebhook('http://example.com', { delay: noDelay })).toEqual({ success: false, error: 'invalid_url' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('succeeds', async () => {
    fetchMock.mockResolvedValue(res(200));
    expect(await sendTestWebhook(URL_OK, { delay: noDelay })).toEqual({ success: true });
    expect(JSON.stringify(fetchMock.mock.calls[0][1].body)).toContain('test');
  });

  it('reports delivery_failed without leaking the url', async () => {
    fetchMock.mockResolvedValue(res(500));
    const r = await sendTestWebhook(URL_OK, { delay: noDelay });
    expect(r).toEqual({ success: false, error: 'delivery_failed' });
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });
});
