import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWebhookPayload } from '../../task-webhook-core';
import { sendWebhook as desktopSendWebhook } from '../../task-webhook';
import type { RunOutcome } from '../outcome';
import {
  eventsForOutcome,
  notifyHeadlessOutcome,
  projectNameFromPath,
  readSpecTitle,
  resolveHeadlessWebhook,
  resolveServeWebhookSettings,
  type ResolvedHeadlessWebhook
} from '../webhook';

const mocks = vi.hoisted(() => ({ settings: undefined as Record<string, unknown> | undefined }));
vi.mock('../../webhook-approval-store', () => ({ getWebhookApprovals: () => ({ urls: [] }) }));
vi.mock('../../project-webhook-config', () => ({ getProjectWebhookConfig: () => null }));
vi.mock('../../app-logger', () => ({ appLog: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../settings-utils', () => ({ readSettingsFile: () => mocks.settings }));

const URL_OK = 'https://hooks.example.com/services/SECRET/PATH';
const noDelay = () => Promise.resolve();
const allOn = { reviewReady: true, failed: true, blocked: true, prOpened: true };
const success: RunOutcome = { kind: 'success', exitCode: 0 };

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('resolveHeadlessWebhook', () => {
  it('returns undefined when nothing is configured', () => {
    expect(resolveHeadlessWebhook({}, {})).toBeUndefined();
    expect(resolveHeadlessWebhook({}, { APERANT_WEBHOOK_URL: '   ' })).toBeUndefined();
  });

  it('env overrides config', () => {
    const r = resolveHeadlessWebhook(
      { webhook: { url: 'https://config.example.com/x' } },
      { APERANT_WEBHOOK_URL: URL_OK }
    );
    expect(r).toMatchObject({ url: URL_OK });
  });

  it('uses the config url when env is unset', () => {
    const r = resolveHeadlessWebhook({ webhook: { url: URL_OK } }, {});
    expect(r).toMatchObject({ url: URL_OK });
  });

  it('invalid url gives a warning naming the rule but not the url', () => {
    const bad = 'http://secret-host.example.com/token123';
    const r = resolveHeadlessWebhook({}, { APERANT_WEBHOOK_URL: bad });
    expect(r).toHaveProperty('warning');
    const warning = (r as { warning: string }).warning;
    expect(warning).toContain('https_required');
    expect(warning).not.toContain('secret-host');
    expect(warning).not.toContain('token123');
  });

  it('keeps the configured format', () => {
    const r = resolveHeadlessWebhook({ webhook: { url: URL_OK, format: 'teams' } }, {}) as ResolvedHeadlessWebhook;
    expect(r.format).toBe('teams');
    expect((resolveHeadlessWebhook({ webhook: { url: URL_OK } }, {}) as ResolvedHeadlessWebhook).format).toBeUndefined();
  });

  it('prOpened is off by default and toggles merge', () => {
    const def = resolveHeadlessWebhook({ webhook: { url: URL_OK } }, {}) as ResolvedHeadlessWebhook;
    expect(def.events).toEqual({ reviewReady: true, failed: true, blocked: true, prOpened: false });
    const custom = resolveHeadlessWebhook(
      { webhook: { url: URL_OK, events: { prOpened: true, failed: false } } },
      {}
    ) as ResolvedHeadlessWebhook;
    expect(custom.events).toEqual({ reviewReady: true, failed: false, blocked: true, prOpened: true });
  });
});

describe('webhook secret', () => {
  it('env overrides config and absent means unsigned', () => {
    const fromConfig = resolveHeadlessWebhook({ webhook: { url: URL_OK, secret: 'cfg' } }, {});
    expect(fromConfig).toMatchObject({ secret: 'cfg' });
    const fromEnv = resolveHeadlessWebhook(
      { webhook: { url: URL_OK, secret: 'cfg' } },
      { APERANT_WEBHOOK_SECRET: ' envsecret ' }
    );
    expect(fromEnv).toMatchObject({ secret: 'envsecret' });
    const none = resolveHeadlessWebhook({ webhook: { url: URL_OK } }, { APERANT_WEBHOOK_SECRET: '  ' });
    expect(none).not.toHaveProperty('secret');
  });

  it('notifyHeadlessOutcome passes the secret to send', async () => {
    const send = vi.fn().mockResolvedValue({ status: 'delivered' });
    await notifyHeadlessOutcome({
      webhook: { url: URL_OK, secret: 'abc', events: allOn },
      outcome: success,
      projectName: 'p',
      taskTitle: 't',
      warn: vi.fn(),
      send
    });
    expect(send.mock.calls[0][2]).toMatchObject({ secret: 'abc' });
  });

  it('sends the formatted body with the secret when both are set', async () => {
    const send = vi.fn().mockResolvedValue({ status: 'delivered' });
    await notifyHeadlessOutcome({
      webhook: { url: URL_OK, format: 'discord', secret: 'abc', events: allOn },
      outcome: success,
      projectName: 'p',
      taskTitle: 't',
      warn: vi.fn(),
      send
    });
    expect(Array.isArray(send.mock.calls[0][1].embeds)).toBe(true);
    expect(send.mock.calls[0][2]).toMatchObject({ secret: 'abc' });
    const both = resolveHeadlessWebhook({ webhook: { url: URL_OK, format: 'teams', secret: 'cfg' } }, {});
    expect(both).toMatchObject({ format: 'teams', secret: 'cfg' });
    const serve = resolveServeWebhookSettings({ webhook: { enabled: true, url: URL_OK, format: 'teams', secret: 'abc' } });
    expect(serve).toMatchObject({ format: 'teams', secret: 'abc' });
  });

  it('serve settings carry the config secret only', () => {
    const settings = resolveServeWebhookSettings({ webhook: { enabled: true, url: URL_OK, secret: 'abc' } });
    expect(settings.secret).toBe('abc');
    expect(resolveServeWebhookSettings({ webhook: { enabled: true, url: URL_OK } })).not.toHaveProperty('secret');
  });

  it('desktop and headless signatures are byte-for-byte identical', async () => {
    const secret = 'parity-secret';
    const fixedMs = 1_700_000_123_456;
    vi.spyOn(Date, 'now').mockReturnValue(fixedMs);
    fetchMock.mockResolvedValue({ status: 200 });
    const payload = buildWebhookPayload({ projectName: 'p', taskTitle: 't', event: 'review_ready' });

    await desktopSendWebhook(URL_OK, payload, { eventName: 'review_ready', secret });
    await notifyHeadlessOutcome({
      webhook: { url: URL_OK, secret, events: allOn },
      outcome: success,
      projectName: 'p',
      taskTitle: 't',
      warn: vi.fn(),
      delay: noDelay
    });
    vi.restoreAllMocks();

    const [desktop, headless] = fetchMock.mock.calls.map((c) => c[1] as { body: string; headers: Record<string, string> });
    expect(desktop.body).toBe(headless.body);
    const timestamp = String(Math.floor(fixedMs / 1000));
    const expected = `sha256=${createHmac('sha256', secret).update(`${timestamp}.${desktop.body}`).digest('hex')}`;
    for (const init of [desktop, headless]) {
      expect(init.headers['X-Aperant-Timestamp']).toBe(timestamp);
      expect(init.headers['X-Aperant-Signature']).toBe(expected);
    }
  });
});

describe('resolveServeWebhookSettings', () => {
  it('is disabled with default events when nothing is configured', () => {
    expect(resolveServeWebhookSettings({})).toEqual({
      enabled: false,
      url: '',
      events: { reviewReady: true, failed: true, blocked: true, prOpened: false }
    });
  });

  it('merges events over the defaults and needs enabled: true', () => {
    const webhook = { url: URL_OK, events: { prOpened: true, failed: false } };
    expect(resolveServeWebhookSettings({ webhook: { ...webhook, enabled: true } })).toEqual({
      enabled: true,
      url: URL_OK,
      events: { reviewReady: true, failed: false, blocked: true, prOpened: true }
    });
    expect(resolveServeWebhookSettings({ webhook }).enabled).toBe(false);
  });

  it('carries the format, and omits it when auto or unset', () => {
    const webhook = { enabled: true, url: URL_OK };
    expect(resolveServeWebhookSettings({ webhook: { ...webhook, format: 'teams' } }).format).toBe('teams');
    expect(resolveServeWebhookSettings({ webhook: { ...webhook, format: 'auto' } })).not.toHaveProperty('format');
    expect(resolveServeWebhookSettings({ webhook })).not.toHaveProperty('format');
  });

  it('rejects an invalid url without printing it', () => {
    expect(() => resolveServeWebhookSettings({ webhook: { enabled: true, url: 'http://example.com/x' } })).toThrow(
      /https_required/
    );
    expect(() => resolveServeWebhookSettings({ webhook: { enabled: true } })).toThrow(/webhook.url is not valid/);
    let message = '';
    try {
      resolveServeWebhookSettings({ webhook: { url: 'ftp://secret.example.com/x' } });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/webhook.url is not valid/);
    expect(message).not.toContain('secret.example.com');
  });
});

describe('eventsForOutcome', () => {
  it('maps the three outcomes', () => {
    expect(eventsForOutcome(success, allOn)).toEqual(['review_ready']);
    expect(eventsForOutcome({ kind: 'qa_failed', exitCode: 2 }, allOn)).toEqual(['blocked']);
    expect(eventsForOutcome({ kind: 'error', exitCode: 1 }, allOn)).toEqual(['failed']);
  });

  it('maps an account pause to account_required, gated by the blocked toggle', () => {
    const paused: RunOutcome = { kind: 'error', exitCode: 1, accountPaused: true };
    expect(eventsForOutcome(paused, allOn)).toEqual(['account_required']);
    expect(eventsForOutcome(paused, { ...allOn, blocked: false })).toEqual([]);
  });

  it('appends pr_opened after the outcome event', () => {
    const outcome: RunOutcome = { ...success, prUrl: 'https://github.com/o/r/pull/1' };
    expect(eventsForOutcome(outcome, allOn)).toEqual(['review_ready', 'pr_opened']);
  });

  it('filters by toggles', () => {
    const outcome: RunOutcome = { ...success, prUrl: 'https://github.com/o/r/pull/1' };
    expect(eventsForOutcome(outcome, { ...allOn, prOpened: false })).toEqual(['review_ready']);
    expect(eventsForOutcome(outcome, { ...allOn, reviewReady: false })).toEqual(['pr_opened']);
    expect(eventsForOutcome({ kind: 'error', exitCode: 1 }, { ...allOn, failed: false })).toEqual([]);
  });
});

describe('notifyHeadlessOutcome', () => {
  const webhook: ResolvedHeadlessWebhook = { url: URL_OK, events: allOn };

  it('sends the same payload the desktop builds', async () => {
    fetchMock.mockResolvedValue({ status: 200 } as Response);
    const prUrl = 'https://github.com/o/r/pull/1';
    await notifyHeadlessOutcome({
      webhook,
      outcome: { ...success, prUrl },
      projectName: 'proj',
      taskTitle: 'My task',
      warn: vi.fn(),
      delay: noDelay
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body));
    expect(bodies[0]).toEqual(
      buildWebhookPayload({ projectName: 'proj', taskTitle: 'My task', event: 'review_ready' })
    );
    expect(bodies[1]).toEqual(
      buildWebhookPayload({ projectName: 'proj', taskTitle: 'My task', event: 'pr_opened', prUrl })
    );
  });

  it('builds the body for the configured format and sends it through the injected send', async () => {
    const run = async (hook: ResolvedHeadlessWebhook) => {
      const send = vi.fn().mockResolvedValue({ status: 'delivered' });
      await notifyHeadlessOutcome({
        webhook: hook,
        outcome: success,
        projectName: 'proj',
        taskTitle: 'My task',
        warn: vi.fn(),
        send
      });
      expect(send).toHaveBeenCalledTimes(1);
      return send.mock.calls[0] as [string, unknown];
    };
    const base = { projectName: 'proj', taskTitle: 'My task', event: 'review_ready' as const };

    const [, teams] = await run({ ...webhook, format: 'teams' });
    expect(teams).toEqual(buildWebhookPayload({ ...base, format: 'teams' }));
    const [, discord] = await run({ ...webhook, format: 'discord' });
    expect(discord).toEqual(buildWebhookPayload({ ...base, format: 'discord' }));
    const [, slack] = await run({ ...webhook, format: 'slack' });
    expect(slack).toEqual(buildWebhookPayload({ ...base, format: 'slack' }));
    const [, unset] = await run(webhook);
    expect(unset).toEqual(buildWebhookPayload(base));
    const [, auto] = await run({ ...webhook, format: 'auto' });
    expect(auto).toEqual(buildWebhookPayload(base));
  });

  it('auto-detects a Teams url when no format is set', async () => {
    const send = vi.fn().mockResolvedValue({ status: 'delivered' });
    await notifyHeadlessOutcome({
      webhook: { url: 'https://prod-1.westus.logic.azure.com/workflows/abc', events: allOn },
      outcome: success,
      projectName: 'proj',
      taskTitle: 'My task',
      warn: vi.fn(),
      send
    });
    expect(send.mock.calls[0][1]).toEqual(
      buildWebhookPayload({ projectName: 'proj', taskTitle: 'My task', event: 'review_ready', format: 'teams' })
    );
  });

  it('a failing endpoint stops after 3 attempts, warns, and returns normally', async () => {
    fetchMock.mockResolvedValue({ status: 500 } as Response);
    const warn = vi.fn();
    await expect(
      notifyHeadlessOutcome({ webhook, outcome: success, projectName: 'p', taskTitle: 't', warn, delay: noDelay })
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(
      'webhook delivery failed for event review_ready; the run result is unchanged'
    );
    for (const call of warn.mock.calls) expect(String(call[0])).not.toContain('SECRET');
  });

  it('does not throw when fetch throws', async () => {
    fetchMock.mockRejectedValue(new Error('boom'));
    const warn = vi.fn();
    await expect(
      notifyHeadlessOutcome({ webhook, outcome: success, projectName: 'p', taskTitle: 't', warn, delay: noDelay })
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('does not throw when warn throws', async () => {
    fetchMock.mockResolvedValue({ status: 500 } as Response);
    const warn = vi.fn(() => {
      throw new Error('bad logger');
    });
    await expect(
      notifyHeadlessOutcome({ webhook, outcome: success, projectName: 'p', taskTitle: 't', warn, delay: noDelay })
    ).resolves.toBeUndefined();
  });
});

describe('readSpecTitle / projectNameFromPath', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'webhook-spec-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the first heading', () => {
    writeFileSync(join(dir, 'spec.md'), 'intro\n# Add feature\n# Other\n');
    expect(readSpecTitle(dir, '001-x')).toBe('Add feature');
  });

  it('falls back to the spec id', () => {
    expect(readSpecTitle(dir, '001-x')).toBe('001-x');
    writeFileSync(join(dir, 'spec.md'), 'no heading here\n');
    expect(readSpecTitle(dir, '001-x')).toBe('001-x');
  });

  it('derives the project name from the path', () => {
    expect(projectNameFromPath('/a/b/myproj/')).toBe('myproj');
    expect(projectNameFromPath('/a/b/myproj')).toBe('myproj');
  });
});
