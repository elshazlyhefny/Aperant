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
import { getProjectWebhookConfig } from './project-webhook-config';
import { getWebhookApprovals } from './webhook-approval-store';
import {
  sendWebhook as sendWebhookCore,
  validateWebhookUrl,
  deliverWebhookEvent,
  prepareTestWebhookDelivery,
  type WebhookPayload
} from './task-webhook-core';
import { mapOutcomeToWebhookEvent } from './webhook-core';
import { isWebhookFormat } from '../shared/utils/webhook-format';

export { validateWebhookUrl, buildWebhookPayload } from './task-webhook-core';
export { mapOutcomeToWebhookEvent } from './webhook-core';
export type { WebhookEvent, WebhookPayload } from './task-webhook-core';

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
    secret?: string;
    now?: () => number;
  } = {}
): Promise<boolean> {
  return sendWebhookCore(url, payload, { ...options, warn: options.warn ?? safeWarn });
}

function loadWebhookSettings(): WebhookSettings {
  const raw = readSettingsFile() ?? {};
  const merged = { ...DEFAULT_APP_SETTINGS, ...raw };
  const def = DEFAULT_APP_SETTINGS.webhook;
  const w: Partial<WebhookSettings> = merged.webhook ?? {};
  return {
    enabled: w.enabled === true,
    url: typeof w.url === 'string' ? w.url : def.url,
    secret: typeof w.secret === 'string' ? w.secret : '',
    events: { ...def.events, ...(w.events ?? {}) },
    // zeenha fork: omitted unless valid, so existing settings behave exactly as before.
    ...(isWebhookFormat(w.format) || w.format === 'auto' ? { format: w.format } : {})
  };
}

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
    const { projectName, taskTitle, prUrl } = input;
    const deliveryInput = { event, projectName, taskTitle, prUrl };
    // An APPROVED project webhook overrides the app-wide one exclusively. An
    // unapproved or refused one is untrusted: it never receives task data.
    const projectConfig = input.project
      ? getProjectWebhookConfig(input.project, getWebhookApprovals(input.project.path))
      : null;
    if (projectConfig?.status === 'approved') {
      void deliverWebhookEvent(
        {
          url: projectConfig.url,
          format: projectConfig.format,
          events: projectConfig.events,
          secret: () => loadWebhookSettings().secret
        },
        deliveryInput,
        { warn: safeWarn }
      ).catch(() => undefined);
      return;
    }
    if (projectConfig) {
      safeWarn('[Webhook] project webhook not approved, using app-wide webhook');
    }
    const settings = loadWebhookSettings();
    if (!settings.enabled || !validateWebhookUrl(settings.url).ok) return;
    void deliverWebhookEvent(settings, deliveryInput, { warn: safeWarn }).catch(() => undefined);
  } catch {
    // never let webhook problems affect task flow
  }
}

export async function sendTestWebhook(
  url: string,
  options: { delay?: (ms: number) => Promise<void>; format?: string; secret?: string; now?: () => number } = {}
): Promise<{ success: boolean; error?: string }> {
  try {
    const check = validateWebhookUrl(url);
    if (!check.ok) return { success: false, error: 'invalid_url' };
    const delivery = prepareTestWebhookDelivery(url, options.format);
    const ok = await sendWebhook(delivery.url, delivery.payload, {
      eventName: 'test',
      delay: options.delay,
      secret: options.secret,
      now: options.now
    });
    return ok ? { success: true } : { success: false, error: 'delivery_failed' };
  } catch {
    return { success: false, error: 'delivery_failed' };
  }
}
