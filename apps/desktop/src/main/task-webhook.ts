/**
 * Outgoing task-outcome webhook (Slack-compatible JSON body).
 *
 * Security: payloads are built from an allow-list of fields only; the URL,
 * request body and response body are never logged; nothing here throws.
 */

import type { TaskStatus, ReviewReason } from '../shared/types';
import type { WebhookSettings } from '../shared/types/settings';
import { DEFAULT_APP_SETTINGS } from '../shared/constants/config';
import { appLog } from './app-logger';
import { readSettingsFile } from './settings-utils';
import {
  sendWebhook as sendWebhookCore,
  validateWebhookUrl,
  buildWebhookPayload,
  type WebhookEvent,
  type WebhookPayload
} from './task-webhook-core';

export { validateWebhookUrl, buildWebhookPayload } from './task-webhook-core';
export type { WebhookEvent, WebhookPayload } from './task-webhook-core';

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

function safeWarn(message: string): void {
  try {
    appLog.warn(message);
  } catch {
    // never throw from logging
  }
}

export function sendWebhook(
  url: string,
  payload: WebhookPayload,
  options: {
    delay?: (ms: number) => Promise<void>;
    eventName?: string;
    warn?: (message: string) => void;
  } = {}
): Promise<boolean> {
  return sendWebhookCore(url, payload, { ...options, warn: options.warn ?? safeWarn });
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
}): void {
  try {
    const event = mapOutcomeToWebhookEvent(input.status, input.reviewReason);
    if (!event) return;
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
