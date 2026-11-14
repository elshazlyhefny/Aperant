/**
 * Electron-free core of the task-outcome webhook (Slack-compatible JSON body).
 *
 * Security: payloads are built from an allow-list of fields only; the URL,
 * request body and response body are never logged; nothing here throws.
 * Only type imports and the dependency-free sanitizer are allowed here so the
 * module can be loaded outside Electron.
 */

import { sanitizeUrl } from './ipc-handlers/shared/sanitize';

export type WebhookEvent = 'review_ready' | 'failed' | 'blocked' | 'pr_opened';

export interface WebhookPayload {
  text: string;
  blocks: unknown[];
}

export const MAX_URL_LENGTH = 2048;
export const MAX_TITLE_LENGTH = 200;
export const MAX_ATTEMPTS = 3;
export const TIMEOUT_MS = 10000;
export const BASE_DELAY_MS = 500;

export const EVENT_LABELS: Record<WebhookEvent, { event: string; outcome: string }> = {
  review_ready: { event: 'Ready for review', outcome: 'Completed' },
  failed: { event: 'Failed', outcome: 'Error' },
  blocked: { event: 'Blocked', outcome: 'Needs attention' },
  pr_opened: { event: 'PR opened', outcome: 'Awaiting review' }
};

export function validateWebhookUrl(url: string): { ok: boolean; error?: string } {
  if (typeof url !== 'string' || url.length === 0) return { ok: false, error: 'invalid_url' };
  if (url.length > MAX_URL_LENGTH) return { ok: false, error: 'url_too_long' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'invalid_url' };
  }
  if (parsed.username || parsed.password) return { ok: false, error: 'credentials_not_allowed' };
  if (parsed.protocol === 'https:') return { ok: true };
  if (parsed.protocol === 'http:') {
    const host = parsed.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return { ok: true };
    return { ok: false, error: 'https_required' };
  }
  return { ok: false, error: 'unsupported_protocol' };
}

export function sanitizeText(value: string, max: number): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping control chars
  const cleaned = String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

export function escapeMrkdwn(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildWebhookPayload(input: {
  projectName: string;
  taskTitle: string;
  event: WebhookEvent;
  prUrl?: string;
}): WebhookPayload {
  const labels = EVENT_LABELS[input.event];
  const project = escapeMrkdwn(sanitizeText(input.projectName, MAX_TITLE_LENGTH));
  const title = escapeMrkdwn(sanitizeText(input.taskTitle, MAX_TITLE_LENGTH));
  // Only the pr_opened event carries a link, and only an https one.
  const link = input.event === 'pr_opened' ? sanitizeUrl(input.prUrl) : '';
  const hasLink = link.startsWith('https://');
  const baseText = `Aperant task ${labels.event.toLowerCase()}: ${title} (${project})`;
  const text = hasLink ? `${baseText} ${escapeMrkdwn(link)}` : baseText;
  const blocks: unknown[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${labels.event}*\n${title}` } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Project*\n${project}` },
        { type: 'mrkdwn', text: `*Outcome*\n${labels.outcome}` }
      ]
    }
  ];
  if (hasLink) {
    blocks.push({
      type: 'actions',
      elements: [{ type: 'button', text: { type: 'plain_text', text: 'View PR' }, url: link }]
    });
  }
  return { text, blocks };
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendWebhook(
  url: string,
  payload: WebhookPayload,
  options: {
    delay?: (ms: number) => Promise<void>;
    eventName?: string;
    warn?: (message: string) => void;
  } = {}
): Promise<boolean> {
  const delay = options.delay ?? defaultDelay;
  const eventName = options.eventName ?? 'unknown';
  const warn = (message: string): void => {
    try {
      options.warn?.(message);
    } catch {
      // never throw from logging
    }
  };
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let detail: string;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(TIMEOUT_MS),
          redirect: 'error'
        });
        if (res.status >= 200 && res.status < 300) return true;
        detail = `HTTP ${res.status}`;
      } catch (err) {
        detail = err instanceof Error ? err.name : 'UnknownError';
      }
      warn(`[Webhook] delivery failed event=${eventName} attempt=${attempt}/${MAX_ATTEMPTS} reason=${detail}`);
      if (attempt < MAX_ATTEMPTS) {
        try {
          await delay(BASE_DELAY_MS * 2 ** (attempt - 1));
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // never throw
  }
  return false;
}
