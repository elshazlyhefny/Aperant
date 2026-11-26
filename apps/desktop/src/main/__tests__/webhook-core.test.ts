import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebhookSettings } from '../../shared/types/settings';
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
