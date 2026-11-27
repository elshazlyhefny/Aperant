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
import type { DeliveryOperation, DeliveryResult } from '../shared/types/delivery-receipt';
import type { WebhookSettings } from '../shared/types/settings';
import type { DeliveryReceiptRecorder } from './delivery-receipts';
import { appLogPort } from './log-port';
import { prepareWebhookDelivery, sendWebhookDetailed, validateWebhookUrl, type WebhookEvent } from './task-webhook-core';

export function mapOutcomeToWebhookEvent(
  status: TaskStatus | string,
  reviewReason?: ReviewReason | string | null
): WebhookEvent | null {
  if (status === 'error') return 'failed';
  if (status === 'human_review') {
    if (reviewReason === 'completed') return 'review_ready';
    if (reviewReason === 'qa_rejected' || reviewReason === 'errors') return 'blocked';
    // zeenha fork: an account pause can be resumed, so it is not reported as failed.
    if (reviewReason === 'account_required') return 'account_required';
  }
  if (status === 'pr_created') return 'pr_opened';
  return null;
}

const EVENT_TOGGLE: Record<WebhookEvent, keyof WebhookSettings['events']> = {
  review_ready: 'reviewReady',
  failed: 'failed',
  blocked: 'blocked',
  // zeenha fork: an account pause needs attention, so it shares the blocked toggle (no new setting).
  account_required: 'blocked',
  pr_opened: 'prOpened'
};

export interface TaskOutcomeWebhookInput {
  status: TaskStatus | string;
  reviewReason?: ReviewReason | string | null;
  projectName: string;
  taskTitle: string;
  prUrl?: string;
}

/** zeenha fork: apply route gates and optionally record one receipt for the whole send. */
export async function dispatchTaskOutcomeWebhookWith(
  settings: WebhookSettings,
  input: TaskOutcomeWebhookInput,
  options: { recorder?: DeliveryReceiptRecorder; warn?: (message: string) => void } = {}
): Promise<DeliveryResult | undefined> {
  try {
    const event = mapOutcomeToWebhookEvent(input.status, input.reviewReason);
    if (!event || !settings.enabled) return;
    const operation: DeliveryOperation = { operation: 'webhook', event };
    const skip = async (reason: Extract<DeliveryResult, { status: 'skipped' }>['reason']): Promise<DeliveryResult> => {
      await options.recorder?.skip(operation, reason);
      return { status: 'skipped', reason };
    };
    if (!settings.events[EVENT_TOGGLE[event]]) return await skip('event_disabled');
    if (!validateWebhookUrl(settings.url).ok) return await skip(settings.url ? 'invalid_target' : 'missing_target');

    const delivery = prepareWebhookDelivery({
      url: settings.url,
      format: settings.format,
      projectName: input.projectName,
      taskTitle: input.taskTitle,
      event,
      prUrl: input.prUrl
    });
    const sendOptions = {
      eventName: event,
      secret: settings.secret,
      warn: options.warn ?? ((message: string) => appLogPort.warn(message))
    };
    let result: DeliveryResult | undefined;
    const send = async () => {
      result = await sendWebhookDetailed(delivery.url, delivery.payload, sendOptions);
      return result;
    };
    if (!options.recorder) return await send();
    await options.recorder.track({ ...operation, provider: delivery.format }, send);
    return result;
  } catch {
    // never let webhook problems affect task flow
  }
}
