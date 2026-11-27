import type { DeliveryReceiptRecorder } from '../delivery-receipts';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  warn: vi.fn(),
  settings: undefined as Record<string, unknown> | undefined,
  projectConfig: vi.fn(),
  approvals: vi.fn(),
  signingRecord: vi.fn()
}));
vi.mock('../webhook-approval-store', () => ({ getWebhookApprovals: mocks.approvals }));
vi.mock('../webhook-secret-store', () => ({ getProjectWebhookSigningRecord: mocks.signingRecord }));
vi.mock('../project-webhook-config', () => ({ getProjectWebhookConfig: mocks.projectConfig }));
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
import { hashWebhookUrl } from '../project-webhook-approval';
import { verifyWebhookSignature } from '../task-webhook-core';

const URL_OK = 'https://hooks.example.com/services/SECRET/PATH';
const noDelay = () => Promise.resolve();
const res = (status: number) => ({ status }) as Response;

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  mocks.warn.mockReset();
  mocks.settings = undefined;
  mocks.projectConfig.mockReset();
  mocks.projectConfig.mockReturnValue(null);
  mocks.approvals.mockReset();
  mocks.approvals.mockReturnValue({ urls: [] });
  mocks.signingRecord.mockReset().mockReturnValue(null);
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

describe('dispatchTaskOutcomeWebhook with a project webhook', () => {
  const PROJECT_URL = 'https://hooks.example.com/project/PROJSECRET/PATH';
  const project = { path: '/proj', autoBuildPath: '.auto-claude' };
  const input = { status: 'error', projectName: 'P', taskTitle: 'T', project };
  const appWide = {
    webhook: { enabled: true, url: URL_OK, events: { reviewReady: true, failed: true, blocked: true, prOpened: false } }
  };
  const cfg = (failed: boolean, status: 'approved' | 'unapproved' | 'refused' = 'approved') => ({
    url: PROJECT_URL,
    hash: 'h',
    status,
    events: { reviewReady: true, failed, blocked: true, prOpened: false }
  });

  it.each(['approved', 'unapproved', 'refused'] as const)(
    'tracks a single POST for an %s project webhook using the selected route', async (status) => {
      mocks.settings = { webhook: { ...appWide.webhook, format: 'discord' } };
      mocks.projectConfig.mockReturnValue({ ...cfg(true, status), format: 'teams' });
      fetchMock.mockResolvedValue(res(204));
      const recorder = {
        skip: vi.fn(),
        track: vi.fn<DeliveryReceiptRecorder['track']>(async (_operation, send) => { await send(); return undefined; }),
        snapshot: vi.fn()
      };
      expect(await dispatchTaskOutcomeWebhook(input, recorder)).toEqual({ status: 'delivered', attempts: 1, httpStatus: 204 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe(status === 'approved' ? PROJECT_URL : URL_OK);
      expect(recorder.track).toHaveBeenCalledExactlyOnceWith({
        operation: 'webhook', event: 'failed', provider: status === 'approved' ? 'teams' : 'discord'
      }, expect.any(Function));
      expect(recorder.skip).not.toHaveBeenCalled();
    }
  );

  it('records the disabled event on the exclusive project route without falling back', async () => {
    mocks.settings = appWide;
    mocks.projectConfig.mockReturnValue(cfg(false));
    const recorder = { skip: vi.fn(), track: vi.fn(), snapshot: vi.fn() };
    expect(await dispatchTaskOutcomeWebhook(input, recorder)).toEqual({ status: 'skipped', reason: 'event_disabled' });
    expect(recorder.skip).toHaveBeenCalledExactlyOnceWith({ operation: 'webhook', event: 'failed' }, 'event_disabled');
    expect(recorder.track).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends only to the project url when set and the event is enabled', async () => {
    mocks.settings = appWide;
    mocks.projectConfig.mockReturnValue(cfg(true));
    fetchMock.mockResolvedValue(res(200));
    dispatchTaskOutcomeWebhook(input);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(PROJECT_URL);
    expect(mocks.projectConfig).toHaveBeenCalledWith(project, { urls: [] });
  });

  it('sends nothing, not even app-wide, when the project event is disabled', async () => {
    mocks.settings = appWide;
    mocks.projectConfig.mockReturnValue(cfg(false));
    dispatchTaskOutcomeWebhook(input);
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to the app-wide webhook when the project has none', async () => {
    mocks.settings = appWide;
    mocks.projectConfig.mockReturnValue(null);
    fetchMock.mockResolvedValue(res(200));
    dispatchTaskOutcomeWebhook(input);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe(URL_OK);
  });

  it('unapproved project url sends to the app-wide url only, with one URL-free warn', async () => {
    mocks.settings = appWide;
    mocks.projectConfig.mockReturnValue(cfg(true, 'unapproved'));
    fetchMock.mockResolvedValue(res(200));
    dispatchTaskOutcomeWebhook(input);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(URL_OK);
    expect(mocks.approvals).toHaveBeenCalledWith('/proj');
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(mocks.warn.mock.calls);
    expect(logged).not.toContain('PROJSECRET');
    expect(logged).not.toContain('hooks.example.com');
  });

  it('refused (e.g. loopback) project url falls back to the app-wide url', async () => {
    mocks.settings = appWide;
    mocks.projectConfig.mockReturnValue({ ...cfg(true, 'refused'), url: 'http://localhost:9/x' });
    fetchMock.mockResolvedValue(res(200));
    dispatchTaskOutcomeWebhook(input);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe(URL_OK);
  });

  it('unapproved project url with app-wide disabled sends nothing', async () => {
    mocks.settings = { webhook: { ...appWide.webhook, enabled: false } };
    mocks.projectConfig.mockReturnValue(cfg(true, 'unapproved'));
    dispatchTaskOutcomeWebhook(input);
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the old behaviour when no project is passed', async () => {
    mocks.settings = appWide;
    fetchMock.mockResolvedValue(res(200));
    dispatchTaskOutcomeWebhook({ status: 'error', projectName: 'P', taskTitle: 'T' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe(URL_OK);
    expect(mocks.projectConfig).not.toHaveBeenCalled();
  });

  it('never logs the project url', async () => {
    mocks.projectConfig.mockReturnValue(cfg(true));
    fetchMock.mockResolvedValue(res(500));
    dispatchTaskOutcomeWebhook(input);
    await vi.waitFor(() => expect(mocks.warn).toHaveBeenCalled());
    const logged = JSON.stringify(mocks.warn.mock.calls);
    expect(logged).not.toContain('PROJSECRET');
    expect(logged).not.toContain('hooks.example.com');
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

describe('webhook signing secret', () => {
  const PROJECT_URL = 'https://hooks.example.com/project/PROJSECRET/PATH';
  const APP_KEY = 'app-key';
  const PROJECT_KEY = 'proj-key';
  const project = { path: '/proj', autoBuildPath: '.auto-claude' };
  const input = { status: 'error', projectName: 'P', taskTitle: 'T', project };
  const events = { reviewReady: true, failed: true, blocked: true, prOpened: false };
  const withSecret = (secret?: string) => ({ webhook: { enabled: true, url: URL_OK, events, secret } });
  const approved = { url: PROJECT_URL, hash: hashWebhookUrl(PROJECT_URL), status: 'approved', events };
  const signedRecord = {
    urlHash: approved.hash,
    mode: 'signed',
    secret: PROJECT_KEY,
    createdAt: '2026-11-27T00:00:00.000Z'
  };

  function verifiesWith(init: { headers: Record<string, string>; body: string }, key: string): boolean {
    return verifyWebhookSignature(key, init.headers['X-Aperant-Timestamp'], init.body, init.headers['X-Aperant-Signature']);
  }

  beforeEach(() => {
    fetchMock.mockResolvedValue(res(200));
  });

  it('signs app-wide sends with the saved secret', async () => {
    mocks.settings = withSecret('s3cret');
    dispatchTaskOutcomeWebhook(input);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const h = fetchMock.mock.calls[0][1].headers;
    expect(h['X-Aperant-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(h['X-Aperant-Timestamp']).toMatch(/^\d+$/);
  });

  it.each([
    ['no project signing record', APP_KEY, null, 'signing_choice_required'],
    ['an unreadable project key', APP_KEY, { ...signedRecord, secret: '' }, 'secret_unavailable'],
    [
      'a signed record for an old URL',
      '',
      { ...signedRecord, urlHash: hashWebhookUrl(`${PROJECT_URL}/old`) },
      'signing_choice_required'
    ]
  ] as const)('withholds approved project sends without falling back when there is %s', (_case, appKey, record, reason) => {
    mocks.settings = withSecret(appKey);
    mocks.projectConfig.mockReturnValue(approved);
    mocks.signingRecord.mockReturnValue(record);
    dispatchTaskOutcomeWebhook(input);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledExactlyOnceWith(`[Webhook] project webhook delivery withheld reason=${reason}`);
  });

  it('records a withheld project send as a skipped receipt and checks the event toggle first', async () => {
    mocks.settings = withSecret(APP_KEY);
    mocks.signingRecord.mockReturnValue(null);
    const recorder = { skip: vi.fn(), track: vi.fn(), snapshot: vi.fn() };
    mocks.projectConfig.mockReturnValue(approved);
    expect(await dispatchTaskOutcomeWebhook(input, recorder)).toEqual({ status: 'skipped', reason: 'missing_configuration' });
    expect(recorder.skip).toHaveBeenCalledExactlyOnceWith({ operation: 'webhook', event: 'failed' }, 'missing_configuration');
    expect(recorder.track).not.toHaveBeenCalled();

    recorder.skip.mockClear();
    mocks.warn.mockClear();
    mocks.signingRecord.mockClear();
    mocks.projectConfig.mockReturnValue({ ...approved, events: { ...events, failed: false } });
    expect(await dispatchTaskOutcomeWebhook(input, recorder)).toEqual({ status: 'skipped', reason: 'event_disabled' });
    expect(mocks.signingRecord).not.toHaveBeenCalled();
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['no record and no app-wide secret', '', null],
    ['explicit unsigned mode and an app-wide secret', APP_KEY, { ...signedRecord, mode: 'unsigned', secret: '' }]
  ] as const)('sends to the approved project without signature headers with %s', async (_case, appKey, record) => {
    mocks.settings = withSecret(appKey);
    mocks.projectConfig.mockReturnValue(approved);
    mocks.signingRecord.mockReturnValue(record);
    dispatchTaskOutcomeWebhook(input);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, { headers }] = fetchMock.mock.calls[0];
    expect(url).toBe(PROJECT_URL);
    expect(headers['X-Aperant-Signature']).toBeUndefined();
    expect(headers['X-Aperant-Timestamp']).toBeUndefined();
  });

  it('signs project and app-wide deliveries so each verifies only with its own key', async () => {
    mocks.settings = withSecret(APP_KEY);
    mocks.projectConfig.mockReturnValueOnce(approved);
    mocks.signingRecord.mockReturnValue(signedRecord);
    dispatchTaskOutcomeWebhook(input);
    dispatchTaskOutcomeWebhook({ ...input, project: { path: '/other-proj', autoBuildPath: '.auto-claude' } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const [[projectUrl, projectRequest], [appUrl, appRequest]] = fetchMock.mock.calls;
    expect(mocks.signingRecord).toHaveBeenCalledExactlyOnceWith(project.path);
    expect(projectUrl).toBe(PROJECT_URL);
    expect(verifiesWith(projectRequest, PROJECT_KEY)).toBe(true);
    expect(verifiesWith(projectRequest, APP_KEY)).toBe(false);
    expect(appUrl).toBe(URL_OK);
    expect(verifiesWith(appRequest, APP_KEY)).toBe(true);
    expect(verifiesWith(appRequest, PROJECT_KEY)).toBe(false);
  });

  it('adds no signature headers without a secret', async () => {
    mocks.settings = withSecret(undefined);
    dispatchTaskOutcomeWebhook(input);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const h = fetchMock.mock.calls[0][1].headers;
    expect(h['X-Aperant-Signature']).toBeUndefined();
    expect(h['X-Aperant-Timestamp']).toBeUndefined();
  });

  it('ignores a WEBHOOK_SECRET supplied by the project .env', async () => {
    mocks.settings = withSecret(undefined);
    mocks.projectConfig.mockReturnValue({ ...approved, secret: 'env-secret', WEBHOOK_SECRET: 'env-secret' });
    dispatchTaskOutcomeWebhook(input);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][1].headers['X-Aperant-Signature']).toBeUndefined();
  });

  it('signs the test message', async () => {
    await sendTestWebhook(URL_OK, { delay: noDelay, secret: 'k' });
    expect(fetchMock.mock.calls[0][1].headers['X-Aperant-Signature']).toMatch(/^sha256=/);
  });
});

describe('webhook format at send sites', () => {
  const events = { reviewReady: true, failed: true, blocked: true, prOpened: false };
  const input = { status: 'error', projectName: 'P', taskTitle: 'T' };
  const bodyOf = () => JSON.parse(String(fetchMock.mock.calls[0][1].body));

  async function dispatch(webhook: Record<string, unknown>) {
    mocks.settings = { webhook: { enabled: true, events, ...webhook } };
    fetchMock.mockResolvedValue(res(200));
    dispatchTaskOutcomeWebhook(input);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  }

  it('posts a Teams card for format teams', async () => {
    await dispatch({ url: URL_OK, format: 'teams' });
    expect(bodyOf().attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
  });

  it('posts a Discord embed for format discord', async () => {
    await dispatch({ url: URL_OK, format: 'discord' });
    expect(Array.isArray(bodyOf().embeds)).toBe(true);
  });

  it('posts the Slack body for format slack and for an absent format', async () => {
    await dispatch({ url: URL_OK, format: 'slack' });
    expect(bodyOf().blocks).toBeDefined();
  });

  it('keeps the Slack body for an absent format on a Slack-compatible host', async () => {
    await dispatch({ url: ['https://hooks', 'slack.com/services/A/B/C'].join('.') });
    expect(bodyOf().blocks).toBeDefined();
    expect(bodyOf().attachments).toBeUndefined();
  });

  it('keeps the Slack body for an absent format on an unknown host', async () => {
    await dispatch({ url: URL_OK });
    expect(bodyOf().blocks).toBeDefined();
  });

  it('auto-detects a Teams workflow URL when no format is set', async () => {
    await dispatch({ url: 'https://prod-12.westus.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?sig=x' });
    expect(bodyOf().attachments).toBeDefined();
  });

  it('ignores an invalid stored format', async () => {
    await dispatch({ url: URL_OK, format: 'bogus' });
    expect(bodyOf().blocks).toBeDefined();
  });

  it('uses the approved project webhook format', async () => {
    mocks.settings = { webhook: { enabled: true, url: URL_OK, events } };
    mocks.projectConfig.mockReturnValue({ url: URL_OK, hash: 'h', status: 'approved', events, format: 'teams' });
    fetchMock.mockResolvedValue(res(200));
    dispatchTaskOutcomeWebhook({ ...input, project: { path: '/p', autoBuildPath: '.auto-claude' } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(bodyOf().attachments).toBeDefined();
  });

  it('sendTestWebhook sends the format test body', async () => {
    fetchMock.mockResolvedValue(res(200));
    await sendTestWebhook(URL_OK, { delay: noDelay, format: 'teams' });
    expect(bodyOf().attachments).toBeDefined();
  });

  it('signs the exact body bytes that are sent, for every format', async () => {
    const { createHmac } = await import('node:crypto');
    for (const format of ['slack', 'teams', 'discord']) {
      fetchMock.mockReset();
      mocks.settings = { webhook: { enabled: true, url: URL_OK, events, format, secret: 'k' } };
      fetchMock.mockResolvedValue(res(200));
      dispatchTaskOutcomeWebhook(input);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const init = fetchMock.mock.calls[0][1];
      const ts = init.headers['X-Aperant-Timestamp'];
      const expected = `sha256=${createHmac('sha256', 'k').update(`${ts}.${init.body}`).digest('hex')}`;
      expect(init.headers['X-Aperant-Signature']).toBe(expected);
    }
  });

  it('signs the format test body', async () => {
    fetchMock.mockResolvedValue(res(200));
    await sendTestWebhook(URL_OK, { delay: noDelay, format: 'discord', secret: 'k' });
    const init = fetchMock.mock.calls[0][1];
    expect(Array.isArray(JSON.parse(String(init.body)).embeds)).toBe(true);
    expect(init.headers['X-Aperant-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});
