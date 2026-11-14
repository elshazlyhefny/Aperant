/**
 * Outgoing task-outcome webhook (Slack-compatible JSON body).
 * The Electron-free parts live in webhook-core.ts and are re-exported here.
 */

import type { WebhookSettings } from '../shared/types/settings';
import { DEFAULT_APP_SETTINGS } from '../shared/constants/config';
import { appLog } from './app-logger';
import { setLogger } from './log-port';
import { readSettingsFile } from './settings-utils';
import {
  dispatchTaskOutcomeWebhookWith,
  sendWebhook,
  validateWebhookUrl,
  type TaskOutcomeWebhookInput,
  type WebhookPayload
} from './webhook-core';

export {
  buildWebhookPayload,
  dispatchTaskOutcomeWebhookWith,
  mapOutcomeToWebhookEvent,
  sendWebhook,
  validateWebhookUrl
} from './webhook-core';
export type { WebhookEvent, WebhookPayload } from './webhook-core';

// Route log-port output (used by webhook-core) to the desktop logger.
setLogger(appLog);

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

export function dispatchTaskOutcomeWebhook(input: TaskOutcomeWebhookInput): void {
  try {
    dispatchTaskOutcomeWebhookWith(loadWebhookSettings(), input);
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
