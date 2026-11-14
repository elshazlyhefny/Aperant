import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildWebhookPayload,
  sendWebhook,
  validateWebhookUrl,
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
