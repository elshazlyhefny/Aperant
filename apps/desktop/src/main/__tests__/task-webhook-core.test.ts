import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  buildTestWebhookPayload,
  buildWebhookPayload,
  prepareTestWebhookDelivery,
  prepareWebhookDelivery,
  sendWebhook,
  sendWebhookDetailed,
  signWebhookBody,
  validateWebhookUrl,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  type WebhookEvent
} from '../task-webhook-core';

const URL_OK = 'https://hooks.example.com/services/SECRET/PATH';
const res = (status: number) => ({ status }) as Response;

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('validateWebhookUrl', () => {
  it.each([URL_OK, 'http://localhost:3000/x', 'http://127.0.0.1/x', 'http://[::1]:8080/x'])(
    'accepts %s',
    (u) => expect(validateWebhookUrl(u).ok).toBe(true)
  );

  it.each([
    ['', 'invalid_url'],
    ['not a url', 'invalid_url'],
    ['http://example.com/x', 'https_required'],
    ['ftp://example.com/x', 'unsupported_protocol'],
    ['https://user:pw@example.com/x', 'credentials_not_allowed'],
    [`https://example.com/${'a'.repeat(2100)}`, 'url_too_long']
  ])('rejects %s', (u, error) => {
    expect(validateWebhookUrl(u)).toEqual({ ok: false, error });
  });
});

describe('buildWebhookPayload', () => {
  const PR = 'https://github.com/o/r/pull/1';
  const events: Array<[WebhookEvent, string, string]> = [
    ['review_ready', 'Ready for review', 'Completed'],
    ['failed', 'Failed', 'Error'],
    ['blocked', 'Blocked', 'Needs attention'],
    ['pr_opened', 'PR opened', 'Awaiting review']
  ];

  it.each(events)('shapes %s', (event, label, outcome) => {
    const p = buildWebhookPayload({ projectName: 'Proj', taskTitle: 'My task', event });
    const s = JSON.stringify(p);
    expect(p.text).toContain('My task');
    expect(p.text).toContain('(Proj)');
    expect(s).toContain(label);
    expect(s).toContain(outcome);
    expect(p.blocks).toHaveLength(2);
  });

  it('adds a View PR button for an https pr url', () => {
    const p = buildWebhookPayload({ projectName: 'P', taskTitle: 'T', event: 'pr_opened', prUrl: PR });
    const actions = (p.blocks as Array<{ type: string; elements?: Array<{ url?: string }> }>).find(
      (b) => b.type === 'actions'
    );
    expect(actions?.elements?.[0].url).toBe(PR);
    expect(p.text).toContain(PR);
  });

  it('drops a non-https link', () => {
    const p = buildWebhookPayload({
      projectName: 'P',
      taskTitle: 'T',
      event: 'pr_opened',
      prUrl: 'http://github.com/o/r/pull/1'
    });
    expect(p.blocks).toHaveLength(2);
    expect(JSON.stringify(p)).not.toContain('github.com');
  });

  it('ignores prUrl for other events and escapes mrkdwn', () => {
    const p = buildWebhookPayload({
      projectName: 'P',
      taskTitle: '<!channel>\u0007',
      event: 'failed',
      prUrl: PR
    });
    const s = JSON.stringify(p);
    expect(s).not.toContain(PR);
    expect(s).not.toContain('<!channel>');
    expect(s).toContain('&lt;!channel&gt;');
  });
});

describe('multi-format payloads', () => {
  const PR = 'https://github.com/o/r/pull/1';
  const evs: WebhookEvent[] = ['review_ready', 'failed', 'blocked', 'pr_opened'];

  it('pins the exact Slack JSON, with and without format', () => {
    const a = {
      review_ready: '{"text":"Aperant task ready for review: T (P)","blocks":[{"type":"section","text":{"type":"mrkdwn","text":"*Ready for review*\\nT"}},{"type":"section","fields":[{"type":"mrkdwn","text":"*Project*\\nP"},{"type":"mrkdwn","text":"*Outcome*\\nCompleted"}]}]}',
      pr_opened: `{"text":"Aperant task pr opened: T (P) ${PR}","blocks":[{"type":"section","text":{"type":"mrkdwn","text":"*PR opened*\\nT"}},{"type":"section","fields":[{"type":"mrkdwn","text":"*Project*\\nP"},{"type":"mrkdwn","text":"*Outcome*\\nAwaiting review"}]},{"type":"actions","elements":[{"type":"button","text":{"type":"plain_text","text":"View PR"},"url":"${PR}"}]}]}`
    };
    for (const event of ['review_ready', 'pr_opened'] as const) {
      for (const format of [undefined, 'slack' as const]) {
        const p = buildWebhookPayload({ projectName: 'P', taskTitle: 'T', event, prUrl: PR, format });
        expect(JSON.stringify(p)).toBe(a[event]);
      }
    }
  });

  it.each(evs)('teams %s', (event) => {
    const p = buildWebhookPayload({ projectName: 'Proj', taskTitle: 'Task', event, format: 'teams' });
    expect(p.type).toBe('message');
    const card = p.attachments[0].content;
    expect(card.version).toBe('1.4');
    expect(card.body).toHaveLength(3);
    expect(JSON.stringify(card)).toContain('Proj');
    expect(card.actions).toBeUndefined();
  });

  it.each(evs)('discord %s', (event) => {
    const p = buildWebhookPayload({ projectName: 'Proj', taskTitle: 'Task', event, format: 'discord' });
    expect(p.allowed_mentions).toEqual({ parse: [] });
    expect(p.embeds[0].description).toBe('Task');
    expect(p.embeds[0].url).toBeUndefined();
    expect(p.embeds[0].fields.map((f) => f.name)).toEqual(['Project', 'Outcome']);
  });

  it('adds link only for https pr_opened', () => {
    const t = buildWebhookPayload({ projectName: 'P', taskTitle: 'T', event: 'pr_opened', prUrl: PR, format: 'teams' });
    expect(t.attachments[0].content.actions).toEqual([{ type: 'Action.OpenUrl', title: 'View PR', url: PR }]);
    const d = buildWebhookPayload({ projectName: 'P', taskTitle: 'T', event: 'pr_opened', prUrl: PR, format: 'discord' });
    expect(d.embeds[0].url).toBe(PR);
    expect(d.embeds[0].fields.map((f) => f.name)).toContain('Pull request');
    for (const format of ['teams', 'discord'] as const) {
      const http = buildWebhookPayload({ projectName: 'P', taskTitle: 'T', event: 'pr_opened', prUrl: 'http://github.com/o/r/pull/1', format });
      expect(JSON.stringify(http)).not.toContain('github.com');
      const other = buildWebhookPayload({ projectName: 'P', taskTitle: 'T', event: 'failed', prUrl: PR, format });
      expect(JSON.stringify(other)).not.toContain(PR);
    }
  });

  it('escapes markdown, strips control chars and truncates', () => {
    const d = buildWebhookPayload({ projectName: 'P', taskTitle: '**bold** [x](y)\u0007', event: 'failed', format: 'discord' });
    expect(d.embeds[0].description).toBe('\\*\\*bold\\*\\* \\[x\\]\\(y\\)');
    const t = buildWebhookPayload({ projectName: 'P', taskTitle: 'a'.repeat(500), event: 'failed', format: 'teams' });
    expect(t.attachments[0].content.body[1]).toMatchObject({ text: `${'a'.repeat(199)}…` });
  });

  it('prepareWebhookDelivery resolves format and strips discord /slack', () => {
    const d = prepareWebhookDelivery({
      url: 'https://discord.com/api/webhooks/1/abc/slack',
      format: 'discord',
      projectName: 'P',
      taskTitle: 'T',
      event: 'failed'
    });
    expect(d.format).toBe('discord');
    expect(d.url).toBe('https://discord.com/api/webhooks/1/abc');
    expect('embeds' in d.payload).toBe(true);
    const auto = prepareWebhookDelivery({ url: 'https://x.webhook.office.com/a', projectName: 'P', taskTitle: 'T', event: 'failed' });
    expect(auto.format).toBe('teams');
    expect(auto.url).toBe('https://x.webhook.office.com/a');
    const slackCompat = prepareWebhookDelivery({ url: 'https://discord.com/api/webhooks/1/abc/slack', projectName: 'P', taskTitle: 'T', event: 'failed' });
    expect(slackCompat.format).toBe('slack');
    expect(slackCompat.url).toBe('https://discord.com/api/webhooks/1/abc/slack');
  });

  it('builds test deliveries per format', () => {
    expect(buildTestWebhookPayload('slack')).toEqual({
      text: 'Aperant test notification: your webhook is configured correctly.',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*Test notification*\nThis is a test message from Aperant.' } }]
    });
    expect(prepareTestWebhookDelivery('https://x.webhook.office.com/a').format).toBe('teams');
    expect(prepareTestWebhookDelivery('https://discord.com/api/webhooks/1/a/github').url).toBe('https://discord.com/api/webhooks/1/a');
  });
});

describe('sendWebhook', () => {
  const payload = buildWebhookPayload({ projectName: 'P', taskTitle: 'T', event: 'failed' });

  it('succeeds on 2xx on the first attempt', async () => {
    fetchMock.mockResolvedValueOnce(res(204));
    const delay = vi.fn().mockResolvedValue(undefined);
    expect(await sendWebhook(URL_OK, payload, { delay })).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
    const init = fetchMock.mock.calls[0][1];
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
  });

  it('retries 3 times with 500 ms then 1000 ms backoff', async () => {
    fetchMock.mockResolvedValue(res(500));
    const delay = vi.fn().mockResolvedValue(undefined);
    expect(await sendWebhook(URL_OK, payload, { delay })).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(delay.mock.calls.map((c) => c[0])).toEqual([500, 1000]);
  });

  it('counts a redirect error as a failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('redirect'));
    const delay = vi.fn().mockResolvedValue(undefined);
    expect(await sendWebhook(URL_OK, payload, { delay })).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('gives warn no URL or body', async () => {
    fetchMock.mockRejectedValue(new Error(`failed for ${URL_OK}`));
    const warn = vi.fn();
    await sendWebhook(URL_OK, payload, { delay: () => Promise.resolve(), eventName: 'failed', warn });
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[0][0]).toBe('[Webhook] delivery failed event=failed attempt=1/3 reason=Error');
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain('SECRET');
    expect(logged).not.toContain('hooks.example.com');
    expect(logged).not.toContain('failed for');
  });

  describe('signing', () => {
    const SECRET = 'whsec-test-secret';
    const expected = (ts: string, body: string) =>
      `sha256=${createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex')}`;

    it('signWebhookBody matches an independent HMAC computation', () => {
      expect(signWebhookBody(SECRET, '1700000000', '{"a":1}')).toBe(expected('1700000000', '{"a":1}'));
      expect(signWebhookBody(SECRET, '1700000000', '{"a":1}')).toMatch(/^sha256=[0-9a-f]{64}$/);
    });

    it('adds timestamp and verifiable signature headers when a secret is set', async () => {
      fetchMock.mockResolvedValueOnce(res(200));
      await sendWebhook(URL_OK, payload, { secret: SECRET, now: () => 1_700_000_123_456 });
      const init = fetchMock.mock.calls[0][1];
      expect(init.headers[WEBHOOK_TIMESTAMP_HEADER]).toBe('1700000123');
      expect(init.headers['Content-Type']).toBe('application/json');
      expect(init.body).toBe(JSON.stringify(payload));
      expect(init.headers[WEBHOOK_SIGNATURE_HEADER]).toBe(expected('1700000123', init.body));
    });

    it.each([undefined, ''])('adds no extra headers when secret is %j', async (secret) => {
      fetchMock.mockResolvedValueOnce(res(200));
      await sendWebhook(URL_OK, payload, { secret });
      const init = fetchMock.mock.calls[0][1];
      expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(init.body).toBe(JSON.stringify(payload));
    });

    it('uses a fresh timestamp on each retry attempt', async () => {
      fetchMock.mockResolvedValue(res(500));
      let t = 1_700_000_000_000;
      await sendWebhook(URL_OK, payload, {
        secret: SECRET,
        now: () => {
          t += 5000;
          return t;
        },
        delay: () => Promise.resolve()
      });
      const stamps = fetchMock.mock.calls.map((c) => c[1].headers[WEBHOOK_TIMESTAMP_HEADER]);
      expect(new Set(stamps).size).toBe(3);
      for (const c of fetchMock.mock.calls) {
        const h = c[1].headers;
        expect(h[WEBHOOK_SIGNATURE_HEADER]).toBe(expected(h[WEBHOOK_TIMESTAMP_HEADER], c[1].body));
      }
    });

    it('never logs the secret, timestamp or signature', async () => {
      fetchMock.mockResolvedValue(res(500));
      const warn = vi.fn();
      await sendWebhook(URL_OK, payload, {
        secret: SECRET,
        now: () => 1_700_000_123_456,
        delay: () => Promise.resolve(),
        warn
      });
      expect(warn).toHaveBeenCalledTimes(3);
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain(SECRET);
      expect(logged).not.toContain('sha256=');
      expect(logged).not.toContain('1700000123');
    });
  });

  it('never throws, even if warn or delay throw', async () => {
    fetchMock.mockResolvedValue(res(500));
    await expect(
      sendWebhook(URL_OK, payload, {
        delay: () => Promise.reject(new Error('x')),
        warn: () => {
          throw new Error('y');
        }
      })
    ).resolves.toBe(false);
  });
});

describe('sendWebhookDetailed', () => {
  const payload = buildWebhookPayload({ projectName: 'P', taskTitle: 'T', event: 'failed' });
  const delay = () => Promise.resolve();

  it.each([[403, 'rejected'], [429, 'rate_limited']])('classifies exhausted HTTP %i as failed', async (httpStatus, reason) => {
    fetchMock.mockResolvedValue(res(httpStatus));
    expect(await sendWebhookDetailed(URL_OK, payload, { delay })).toEqual({
      status: 'failed', reason, attempts: 3, httpStatus
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['TimeoutError', 'timeout'],
    ['AbortError', 'transport_error'],
    ['TypeError', 'transport_error']
  ])('keeps a %s unknown even after two explicit rejections', async (name, reason) => {
    const error = Object.assign(new Error('private transport detail'), { name });
    fetchMock.mockRejectedValueOnce(error).mockResolvedValue(res(429));
    expect(await sendWebhookDetailed(URL_OK, payload, { delay })).toEqual({
      status: 'unknown', reason, attempts: 3
    });
  });

  it.each([[302, 'ambiguous_response'], [502, 'ambiguous_response'], [408, 'timeout']])(
    'keeps HTTP %i unconfirmed even after explicit rejections', async (httpStatus, reason) => {
      fetchMock.mockResolvedValueOnce(res(httpStatus)).mockResolvedValue(res(400));
      expect(await sendWebhookDetailed(URL_OK, payload, { delay })).toEqual({
        status: 'unknown', reason, attempts: 3, httpStatus
      });
    }
  );

  it('lets a later 2xx confirm delivery and uses a new 10s timeout per attempt', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      fetchMock.mockRejectedValueOnce(new DOMException('check timed out', 'TimeoutError'))
        .mockResolvedValueOnce(res(429))
        .mockResolvedValueOnce(res(204));
      expect(await sendWebhookDetailed(URL_OK, payload, { delay })).toEqual({
        status: 'delivered', attempts: 3, httpStatus: 204
      });
      expect(timeout.mock.calls).toEqual([[10_000], [10_000], [10_000]]);
      expect(new Set(fetchMock.mock.calls.map(([, init]) => init.signal)).size).toBe(3);
    } finally {
      timeout.mockRestore();
    }
  });
});
