/**
 * zeenha fork: task-outcome webhook for headless runs.
 *
 * Electron-free on purpose: only the shared webhook core, the default settings
 * constants and node builtins. Never imports ../task-webhook, app-logger or
 * settings-utils. The URL is never logged and nothing here throws.
 */

import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DEFAULT_APP_SETTINGS } from '../../shared/constants/config';
import type { DeliveryOperation } from '../../shared/types/delivery-receipt';
import type { WebhookFormat, WebhookSettings } from '../../shared/types/settings';
import type { DeliveryReceiptRecorder } from '../delivery-receipts';
import {
  prepareWebhookDelivery,
  sendWebhookDetailed,
  validateWebhookUrl,
  type WebhookEvent
} from '../task-webhook-core';
import type { HeadlessConfig } from './config';
import type { RunOutcome } from './outcome';

export interface WebhookToggles {
  reviewReady: boolean;
  failed: boolean;
  blocked: boolean;
  prOpened: boolean;
}

export interface ResolvedHeadlessWebhook {
  url: string;
  /** HMAC signing secret; absent means unsigned. */
  secret?: string;
  /** undefined and 'auto' both detect the format from the URL. */
  format?: WebhookFormat | 'auto';
  events: WebhookToggles;
}

interface RejectedHeadlessWebhook {
  warning: string;
  events: WebhookToggles;
}

export function resolveHeadlessWebhook(
  config: HeadlessConfig,
  env: NodeJS.ProcessEnv
): ResolvedHeadlessWebhook | RejectedHeadlessWebhook | undefined {
  const fromEnv = env.APERANT_WEBHOOK_URL?.trim();
  const url = fromEnv ? fromEnv : config.webhook?.url?.trim();
  if (!url) return undefined;

  const defaults = DEFAULT_APP_SETTINGS.webhook.events;
  const overrides = config.webhook?.events ?? {};
  const events = {
    reviewReady: overrides.reviewReady ?? defaults.reviewReady,
    failed: overrides.failed ?? defaults.failed,
    blocked: overrides.blocked ?? defaults.blocked,
    prOpened: overrides.prOpened ?? defaults.prOpened
  };
  const validation = validateWebhookUrl(url);
  if (!validation.ok) {
    return {
      events,
      warning: `webhook disabled: the configured webhook URL was rejected (${validation.error ?? 'invalid_url'})`
    };
  }

  const secretFromEnv = env.APERANT_WEBHOOK_SECRET?.trim();
  const secret = secretFromEnv ? secretFromEnv : config.webhook?.secret?.trim();
  return {
    url,
    ...(secret ? { secret } : {}),
    format: config.webhook?.format,
    events
  };
}

/**
 * Webhook settings for the daemon (`serve`), from the config file only. Unlike
 * `run`, the daemon needs `enabled: true`, does not read APERANT_WEBHOOK_URL
 * and refuses to start with an invalid URL: throws, without the URL in the message.
 */
export function resolveServeWebhookSettings(config: HeadlessConfig): WebhookSettings {
  const defaults = DEFAULT_APP_SETTINGS.webhook;
  const enabled = config.webhook?.enabled === true;
  const url = config.webhook?.url ?? defaults.url;
  if (enabled || url !== '') {
    const check = validateWebhookUrl(url);
    if (!check.ok) {
      throw new Error(`Config: webhook.url is not valid (${check.error ?? 'invalid_url'})`);
    }
  }
  const secret = config.webhook?.secret;
  const format = config.webhook?.format;
  return {
    enabled,
    url,
    ...(format && format !== 'auto' ? { format } : {}),
    events: { ...defaults.events, ...(config.webhook?.events ?? {}) },
    ...(secret ? { secret } : {})
  };
}

function candidateEvents(outcome: RunOutcome): WebhookEvent[] {
  const events: WebhookEvent[] = [];
  // zeenha fork: an account pause is resumable, so it is not reported as failed.
  if (outcome.accountPaused) events.push('account_required');
  else if (outcome.kind === 'success') events.push('review_ready');
  else if (outcome.kind === 'qa_failed') events.push('blocked');
  else events.push('failed');
  if (outcome.prUrl) events.push('pr_opened');

  return events;
}

const EVENT_TOGGLE: Record<WebhookEvent, keyof WebhookToggles> = {
  review_ready: 'reviewReady',
  failed: 'failed',
  blocked: 'blocked',
  account_required: 'blocked',
  pr_opened: 'prOpened'
};

export function eventsForOutcome(outcome: RunOutcome, toggles: WebhookToggles): WebhookEvent[] {
  return candidateEvents(outcome).filter((event) => toggles[EVENT_TOGGLE[event]]);
}

export interface NotifyHeadlessOutcomeInput {
  webhook: ResolvedHeadlessWebhook | RejectedHeadlessWebhook;
  outcome: RunOutcome;
  projectName: string;
  taskTitle: string;
  warn: (message: string) => void;
  delay?: (ms: number) => Promise<void>;
  send?: typeof sendWebhookDetailed;
  recorder?: DeliveryReceiptRecorder;
}

/** Deliver every enabled event for the outcome. Never throws; never changes the run result. */
export async function notifyHeadlessOutcome(input: NotifyHeadlessOutcomeInput): Promise<void> {
  const { webhook, outcome, projectName, taskTitle, delay, recorder } = input;
  const send = input.send ?? sendWebhookDetailed;
  const warn = (message: string): void => {
    try {
      input.warn(message);
    } catch {
      // never throw from logging
    }
  };
  try {
    for (const event of candidateEvents(outcome)) {
      const operation: DeliveryOperation = { operation: 'webhook', event };
      if (!webhook.events[EVENT_TOGGLE[event]]) {
        await recorder?.skip(operation, 'event_disabled');
        continue;
      }
      if ('warning' in webhook) {
        await recorder?.skip(operation, 'invalid_target');
        continue;
      }
      const prepared = prepareWebhookDelivery({
        url: webhook.url,
        format: webhook.format,
        projectName,
        taskTitle,
        event,
        prUrl: event === 'pr_opened' ? outcome.prUrl : undefined
      });
      const deliver = async () => {
        const result = await send(prepared.url, prepared.payload, {
          delay,
          eventName: event,
          warn,
          secret: webhook.secret
        });
        if (result.status !== 'delivered') {
          warn(`webhook delivery failed for event ${event}; the run result is unchanged`);
        }
        return result;
      };
      if (recorder) await recorder.track({ ...operation, provider: prepared.format }, deliver);
      else await deliver();
    }
  } catch {
    warn('webhook delivery failed; the run result is unchanged');
  }
}

/** First `# ` heading of spec.md, else the spec id. */
export function readSpecTitle(specDir: string, specId: string): string {
  try {
    const text = readFileSync(join(specDir, 'spec.md'), 'utf-8');
    for (const line of text.split(/\r?\n/)) {
      const match = /^#\s+(.+?)\s*$/.exec(line);
      if (match?.[1]) return match[1];
    }
  } catch {
    // fall through to the id
  }
  return specId;
}

export function projectNameFromPath(projectPath: string): string {
  return basename(projectPath.replace(/[\\/]+$/, '')) || projectPath;
}
