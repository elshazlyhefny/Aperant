/**
 * Outgoing task-outcome webhook (Slack-compatible JSON body).
 *
 * Security: payloads are built from an allow-list of fields only; the URL,
 * request body and response body are never logged; nothing here throws.
 */

import type { TaskStatus, ReviewReason, Project } from '../shared/types';
import type { WebhookSettings } from '../shared/types/settings';
import { DEFAULT_APP_SETTINGS } from '../shared/constants/config';
import { appLog } from './app-logger';
import { readSettingsFile } from './settings-utils';
import { sanitizeUrl } from './ipc-handlers/shared/sanitize';
import { getProjectWebhookConfig } from './project-webhook-config';

export type WebhookEvent = 'review_ready' | 'failed' | 'blocked' | 'pr_opened';

export interface WebhookPayload {
  text: string;
  blocks: unknown[];
}

const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 200;
const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 10000;
const BASE_DELAY_MS = 500;

const EVENT_LABELS: Record<WebhookEvent, { event: string; outcome: string }> = {
  review_ready: { event: 'Ready for review', outcome: 'Completed' },
  failed: { event: 'Failed', outcome: 'Error' },
  blocked: { event: 'Blocked', outcome: 'Needs attention' },
  pr_opened: { event: 'PR opened', outcome: 'Awaiting review' }
};

export function mapOutcomeToWebhookEvent(
  status: TaskStatus | string,
  reviewReason?: ReviewReason | string | null
): WebhookEvent | null {
  if (status === 'error') return 'failed';
  if (status === 'human_review') {
    if (reviewReason === 'completed') return 'review_ready';
    if (reviewReason === 'qa_rejected' || reviewReason === 'errors') return 'blocked';
  }
  if (status === 'pr_created') return 'pr_opened';
  return null;
}

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

function sanitizeText(value: string, max: number): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping control chars
  const cleaned = String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function escapeMrkdwn(value: string): string {
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

function safeWarn(...args: unknown[]): void {
  try {
    appLog.warn(...args);
  } catch {
    // never throw from logging
  }
}

export async function sendWebhook(
  url: string,
  payload: WebhookPayload,
  options: { delay?: (ms: number) => Promise<void>; eventName?: string } = {}
): Promise<boolean> {
  const delay = options.delay ?? defaultDelay;
  const eventName = options.eventName ?? 'unknown';
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
      safeWarn(`[Webhook] delivery failed event=${eventName} attempt=${attempt}/${MAX_ATTEMPTS} reason=${detail}`);
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

function loadWebhookSettings(): WebhookSettings {
  const raw = readSettingsFile() ?? {};
  const merged = { ...DEFAULT_APP_SETTINGS, ...raw };
  const def = DEFAULT_APP_SETTINGS.webhook;
  const w = merged.webhook ?? {};
  return {
    enabled: w.enabled === true,
    url: typeof w.url === 'string' ? w.url : def.url,
    events: { ...def.events, ...(w.events ?? {}) }
  };
}

const EVENT_TOGGLE: Record<WebhookEvent, keyof WebhookSettings['events']> = {
  review_ready: 'reviewReady',
  failed: 'failed',
  blocked: 'blocked',
  pr_opened: 'prOpened'
};

export function dispatchTaskOutcomeWebhook(input: {
  status: TaskStatus | string;
  reviewReason?: ReviewReason | string | null;
  projectName: string;
  taskTitle: string;
  prUrl?: string;
  project?: Pick<Project, 'path' | 'autoBuildPath'>;
}): void {
  try {
    const event = mapOutcomeToWebhookEvent(input.status, input.reviewReason);
    if (!event) return;
    // A valid project webhook overrides the app-wide one exclusively.
    const projectConfig = input.project ? getProjectWebhookConfig(input.project) : null;
    if (projectConfig) {
      if (!projectConfig.events[EVENT_TOGGLE[event]]) return;
      const projectPayload = buildWebhookPayload({
        projectName: input.projectName,
        taskTitle: input.taskTitle,
        event,
        prUrl: input.prUrl
      });
      void sendWebhook(projectConfig.url, projectPayload, { eventName: event }).catch(() => undefined);
      return;
    }
    const settings = loadWebhookSettings();
    if (!settings.enabled || !settings.events[EVENT_TOGGLE[event]]) return;
    if (!validateWebhookUrl(settings.url).ok) return;
    const payload = buildWebhookPayload({
      projectName: input.projectName,
      taskTitle: input.taskTitle,
      event,
      prUrl: input.prUrl
    });
    void sendWebhook(settings.url, payload, { eventName: event }).catch(() => undefined);
  } catch {
    // never let webhook problems affect task flow
  }
}

export async function sendTestWebhook(
  url: string,
  options: { delay?: (ms: number) => Promise<void> } = {}
): Promise<{ success: boolean; error?: string }> {
  try {
    const check = validateWebhookUrl(url);
    if (!check.ok) return { success: false, error: 'invalid_url' };
    const payload: WebhookPayload = {
      text: 'Aperant test notification: your webhook is configured correctly.',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '*Test notification*\nThis is a test message from Aperant.' }
        }
      ]
    };
    const ok = await sendWebhook(url, payload, { eventName: 'test', delay: options.delay });
    return ok ? { success: true } : { success: false, error: 'delivery_failed' };
  } catch {
    return { success: false, error: 'delivery_failed' };
  }
}
