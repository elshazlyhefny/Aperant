/**
 * Electron-free task-outcome webhook dispatch with injected settings.
 * zeenha fork: lets the CLI daemon (`cli.js serve`) send outcome webhooks.
 * Validation, payload and delivery come from task-webhook-core.ts; delivery
 * warnings go through log-port, never app-logger.
 *
 * Security: the URL, request body and response body are never logged; nothing
 * here throws.
 */

import type { TaskStatus, ReviewReason } from '../shared/types';
import type { WebhookSettings } from '../shared/types/settings';
import { appLogPort } from './log-port';
import { buildWebhookPayload, sendWebhook, validateWebhookUrl, type WebhookEvent } from './task-webhook-core';

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

const EVENT_TOGGLE: Record<WebhookEvent, keyof WebhookSettings['events']> = {
  review_ready: 'reviewReady',
  failed: 'failed',
  blocked: 'blocked',
  pr_opened: 'prOpened'
};

export interface TaskOutcomeWebhookInput {
  status: TaskStatus | string;
  reviewReason?: ReviewReason | string | null;
  projectName: string;
  taskTitle: string;
  prUrl?: string;
}

/** Apply enabled / event-toggle / URL checks to `settings`, then send. Never throws. */
export function dispatchTaskOutcomeWebhookWith(
  settings: WebhookSettings,
  input: TaskOutcomeWebhookInput
): void {
  try {
    const event = mapOutcomeToWebhookEvent(input.status, input.reviewReason);
    if (!event) return;
    if (!settings.enabled || !settings.events[EVENT_TOGGLE[event]]) return;
    if (!validateWebhookUrl(settings.url).ok) return;
    const payload = buildWebhookPayload({
      projectName: input.projectName,
      taskTitle: input.taskTitle,
      event,
      prUrl: input.prUrl
    });
    void sendWebhook(settings.url, payload, {
      eventName: event,
      warn: (message) => appLogPort.warn(message)
    }).catch(() => undefined);
  } catch {
    // never let webhook problems affect task flow
  }
}
