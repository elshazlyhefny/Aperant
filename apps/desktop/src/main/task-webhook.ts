/**
 * Outgoing task-outcome webhook (Slack-compatible JSON body).
 *
 * Security: payloads are built from an allow-list of fields only; the URL,
 * request body and response body are never logged; nothing here throws.
 */

import type { Project } from '../shared/types';
import type { DeliveryResult } from '../shared/types/delivery-receipt';
import type { WebhookSettings } from '../shared/types/settings';
import { DEFAULT_APP_SETTINGS } from '../shared/constants/config';
import { appLog } from './app-logger';
import type { DeliveryReceiptRecorder } from './delivery-receipts';
import { readSettingsFile } from './settings-utils';
import { getProjectWebhookConfig } from './project-webhook-config';
import { resolveProjectWebhookSigning } from './project-webhook-signing';
import { getWebhookApprovals } from './webhook-approval-store';
import { getProjectWebhookSigningRecord } from './webhook-secret-store';
import {
  sendWebhook as sendWebhookCore,
  validateWebhookUrl,
  prepareTestWebhookDelivery,
  type WebhookSendOptions,
  type WebhookPayload
} from './task-webhook-core';
import { dispatchTaskOutcomeWebhookWith, mapOutcomeToWebhookEvent, type TaskOutcomeWebhookInput } from './webhook-core';
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
  options: WebhookSendOptions = {}
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

export async function dispatchTaskOutcomeWebhook(
  input: TaskOutcomeWebhookInput & { project?: Pick<Project, 'path' | 'autoBuildPath'> },
  recorder?: DeliveryReceiptRecorder
): Promise<DeliveryResult | undefined> {
  try {
    const event = mapOutcomeToWebhookEvent(input.status, input.reviewReason);
    if (!event) return;
    // An APPROVED project webhook overrides the app-wide one exclusively. An
    // unapproved or refused one is untrusted: it never receives task data.
    const project = input.project;
    const projectConfig = project
      ? getProjectWebhookConfig(project, getWebhookApprovals(project.path))
      : null;
    if (projectConfig && projectConfig.status !== 'approved') {
      safeWarn('[Webhook] project webhook not approved, using app-wide webhook');
    }
    if (project && projectConfig?.status === 'approved') {
      const destination = {
        enabled: true,
        url: projectConfig.url,
        format: projectConfig.format,
        events: projectConfig.events,
        // zeenha fork: reserve the app-wide key for the app-wide destination;
        // resolved only once the event is enabled and the target is valid.
        secret: () =>
          resolveProjectWebhookSigning({
            record: getProjectWebhookSigningRecord(project.path),
            urlHash: projectConfig.hash,
            appSecretSet: Boolean(loadWebhookSettings().secret)
          })
      };
      return await dispatchTaskOutcomeWebhookWith(destination, input, { recorder, warn: safeWarn });
    }
    return await dispatchTaskOutcomeWebhookWith(loadWebhookSettings(), input, { recorder, warn: safeWarn });
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
