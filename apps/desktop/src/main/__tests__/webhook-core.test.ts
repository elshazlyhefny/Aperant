import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebhookSettings } from '../../shared/types/settings';
import { createDeliveryReceiptRecorder, readDeliveryReceipts } from '../delivery-receipts';
import { dispatchTaskOutcomeWebhookWith, mapOutcomeToWebhookEvent } from '../webhook-core';

const URL_OK = 'https://hooks.example.com/services/X/Y';

function settings(over: Partial<WebhookSettings> = {}): WebhookSettings {
  return {
    enabled: true,
    url: URL_OK,
    events: { reviewReady: true, failed: true, blocked: true, prOpened: true },
    ...over
  } as WebhookSettings;
}

const input = { status: 'error', projectName: 'P', taskTitle: 'T' };

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ status: 200 } as Response);
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('dispatchTaskOutcomeWebhookWith', () => {
  it('sends with injected settings', () => {
    dispatchTaskOutcomeWebhookWith(settings(), input);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(URL_OK);
  });

  it('does nothing when disabled', () => {
    dispatchTaskOutcomeWebhookWith(settings({ enabled: false }), input);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing for an invalid URL', () => {
    dispatchTaskOutcomeWebhookWith(settings({ url: 'http://example.com/hook' }), input);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing when the event toggle is off', () => {
    const s = settings();
    s.events = { ...s.events, failed: false };
    dispatchTaskOutcomeWebhookWith(s, input);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores statuses that map to no event', () => {
    dispatchTaskOutcomeWebhookWith(settings(), { ...input, status: 'in_progress' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('account pause (human_review + account_required)', () => {
  it('maps to account_required, not failed or null', () => {
    expect(mapOutcomeToWebhookEvent('human_review', 'account_required')).toBe('account_required');
    expect(mapOutcomeToWebhookEvent('error', null)).toBe('failed');
  });

  it('sends a Paused message gated by the blocked toggle', () => {
    const pause = { ...input, status: 'human_review', reviewReason: 'account_required' };
    dispatchTaskOutcomeWebhookWith(settings(), pause);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.text).toContain('paused');
    expect(JSON.stringify(body)).not.toContain('Failed');

    fetchMock.mockClear();
    const s = settings();
    s.events = { ...s.events, blocked: false };
    dispatchTaskOutcomeWebhookWith(s, pause);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('dispatchTaskOutcomeWebhookWith format', () => {
  it('posts a Teams card when settings.format is teams', () => {
    dispatchTaskOutcomeWebhookWith(settings({ format: 'teams' }), input);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
  });

  it('posts a Discord embed when settings.format is discord', () => {
    dispatchTaskOutcomeWebhookWith(settings({ format: 'discord' }), input);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(Array.isArray(body.embeds)).toBe(true);
  });

  it('keeps the Slack body when format is absent', () => {
    dispatchTaskOutcomeWebhookWith(settings(), input);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.blocks).toBeDefined();
  });
});

describe('webhook receipts', () => {
  const specId = '001-webhook-test';
  let project: string;
  beforeEach(async () => { project = await mkdtemp(path.join(tmpdir(), 'webhook-receipts-')); });
  afterEach(async () => { await rm(project, { recursive: true, force: true }); });

  it('persists one unconfirmed marker before the first POST and completes that row after a successful retry', async () => {
    const recorder = createDeliveryReceiptRecorder(project, specId);
    const operation = { operation: 'webhook', event: 'failed', provider: 'teams' };
    let before: Awaited<ReturnType<typeof readDeliveryReceipts>> = [];
    fetchMock.mockImplementationOnce(async () => {
      before = await readDeliveryReceipts(project, specId);
      return { status: 429, body: 'private-response-fixture' };
    }).mockResolvedValueOnce({ status: 204 });
    const result = await dispatchTaskOutcomeWebhookWith(
      settings({ format: 'teams', secret: 'private-signing-fixture' }),
      { ...input, taskTitle: 'private-task-fixture' },
      { recorder }
    );
    expect(result).toEqual({ status: 'delivered', attempts: 2, httpStatus: 204 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(before).toEqual([expect.objectContaining({ ...operation, status: 'unknown', reason: 'unconfirmed' })]);
    expect(before[0].completedAt).toBeUndefined();
    const receipts = await readDeliveryReceipts(project, specId);
    expect(receipts).toEqual(recorder.snapshot());
    expect(receipts).toEqual([expect.objectContaining({ ...operation, ...result, id: before[0].id })]);
    const stored = await readFile(path.join(project, '.auto-claude', 'delivery-receipts.json'), 'utf8');
    expect(stored).not.toContain('private-');
    expect(stored).not.toContain(URL_OK);
  });

  it.each([
    ['event_disabled', settings({ events: { reviewReady: true, failed: false, blocked: true, prOpened: true } })],
    ['invalid_target', settings({ url: 'https://user:password@example.com' })],
    ['missing_target', settings({ url: '' })]
  ])('records %s without sending', async (reason, route) => {
    const recorder = createDeliveryReceiptRecorder(project, specId);
    const result = { status: 'skipped', reason };
    expect(await dispatchTaskOutcomeWebhookWith(route, input, { recorder })).toEqual(result);
    expect(recorder.snapshot()).toEqual([expect.objectContaining({ operation: 'webhook', event: 'failed', ...result })]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('makes no receipt for disabled settings or an ineligible outcome', async () => {
    const recorder = createDeliveryReceiptRecorder(project, specId);
    expect(await dispatchTaskOutcomeWebhookWith(settings({ enabled: false }), input, { recorder })).toBeUndefined();
    expect(await dispatchTaskOutcomeWebhookWith(settings(), { ...input, status: 'in_progress' }, { recorder })).toBeUndefined();
    expect(recorder.snapshot()).toEqual([]);
    expect(await readDeliveryReceipts(project, specId)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
