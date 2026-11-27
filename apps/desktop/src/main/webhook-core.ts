/**
 * Electron-free task-outcome webhook dispatch with injected settings.
 * zeenha fork: lets the CLI daemon (`cli.js serve`) send outcome webhooks.
 * Event filtering, validation, payload and delivery come from the shared
 * deliverWebhookEvent in task-webhook-core.ts; delivery warnings go through
 * log-port, never app-logger.
 *
 * Security: the URL, request body and response body are never logged; nothing
 * here throws.
 */

import type { TaskStatus, ReviewReason } from '../shared/types';
import type { DeliveryResult } from '../shared/types/delivery-receipt';
import type { WebhookSettings } from '../shared/types/settings';
import type { DeliveryReceiptRecorder } from './delivery-receipts';
import { appLogPort } from './log-port';
import { deliverWebhookEvent, type WebhookDestination, type WebhookEvent } from './task-webhook-core';

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

export interface TaskOutcomeWebhookInput {
  status: TaskStatus | string;
  reviewReason?: ReviewReason | string | null;
  projectName: string;
  taskTitle: string;
  prUrl?: string;
}

/** zeenha fork: apply the route gate, then the shared filter and delivery (optionally recording one receipt). */
export async function dispatchTaskOutcomeWebhookWith(
  settings: WebhookDestination & Pick<WebhookSettings, 'enabled'>,
  input: TaskOutcomeWebhookInput,
  options: { recorder?: DeliveryReceiptRecorder; warn?: (message: string) => void } = {}
): Promise<DeliveryResult | undefined> {
  try {
    const event = mapOutcomeToWebhookEvent(input.status, input.reviewReason);
    if (!event || !settings.enabled) return;
    return await deliverWebhookEvent(
      settings,
      { event, projectName: input.projectName, taskTitle: input.taskTitle, prUrl: input.prUrl },
      { recorder: options.recorder, warn: options.warn ?? ((message: string) => appLogPort.warn(message)) }
    );
  } catch {
    // never let webhook problems affect task flow
  }
}
