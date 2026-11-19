import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWebhookPayload } from '../../task-webhook-core';
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
      const send = vi.fn().mockResolvedValue(true);
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
    const send = vi.fn().mockResolvedValue(true);
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
