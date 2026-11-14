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
import {
  buildWebhookPayload,
  sendWebhook,
  validateWebhookUrl,
  type WebhookEvent,
  type WebhookPayload
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
  events: WebhookToggles;
}

export function resolveHeadlessWebhook(
  config: HeadlessConfig,
  env: NodeJS.ProcessEnv
): ResolvedHeadlessWebhook | { warning: string } | undefined {
  const fromEnv = env.APERANT_WEBHOOK_URL?.trim();
  const url = fromEnv ? fromEnv : config.webhook?.url?.trim();
  if (!url) return undefined;

  const validation = validateWebhookUrl(url);
  if (!validation.ok) {
    return {
      warning: `webhook disabled: the configured webhook URL was rejected (${validation.error ?? 'invalid_url'})`
    };
  }

  const defaults = DEFAULT_APP_SETTINGS.webhook.events;
  const overrides = config.webhook?.events ?? {};
  return {
    url,
    events: {
      reviewReady: overrides.reviewReady ?? defaults.reviewReady,
      failed: overrides.failed ?? defaults.failed,
      blocked: overrides.blocked ?? defaults.blocked,
      prOpened: overrides.prOpened ?? defaults.prOpened
    }
  };
}

export function eventsForOutcome(outcome: RunOutcome, toggles: WebhookToggles): WebhookEvent[] {
  const events: WebhookEvent[] = [];
  if (outcome.kind === 'success') events.push('review_ready');
  else if (outcome.kind === 'qa_failed') events.push('blocked');
  else events.push('failed');
  if (outcome.prUrl) events.push('pr_opened');

  const enabled: Record<WebhookEvent, boolean> = {
    review_ready: toggles.reviewReady,
    failed: toggles.failed,
    blocked: toggles.blocked,
    pr_opened: toggles.prOpened
  };
  return events.filter((event) => enabled[event]);
}

export interface NotifyHeadlessOutcomeInput {
  webhook: ResolvedHeadlessWebhook;
  outcome: RunOutcome;
  projectName: string;
  taskTitle: string;
  warn: (message: string) => void;
  delay?: (ms: number) => Promise<void>;
  send?: typeof sendWebhook;
}

/** Deliver every enabled event for the outcome. Never throws; never changes the run result. */
export async function notifyHeadlessOutcome(input: NotifyHeadlessOutcomeInput): Promise<void> {
  const { webhook, outcome, projectName, taskTitle, delay } = input;
  const send = input.send ?? sendWebhook;
  const warn = (message: string): void => {
    try {
      input.warn(message);
    } catch {
      // never throw from logging
    }
  };
  try {
    for (const event of eventsForOutcome(outcome, webhook.events)) {
      const payload: WebhookPayload = buildWebhookPayload({
        projectName,
        taskTitle,
        event,
        prUrl: event === 'pr_opened' ? outcome.prUrl : undefined
      });
      const delivered = await send(webhook.url, payload, { delay, eventName: event, warn });
      if (!delivered) {
        warn(`webhook delivery failed for event ${event}; the run result is unchanged`);
      }
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
