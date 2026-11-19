/**
 * zeenha fork: per-project task-outcome webhook config, stored in the
 * project's `<autoBuildPath>/.env`. Never throws and never logs the URL.
 */

import path from 'path';
import { existsSync, readFileSync } from 'fs';
import type { Project } from '../shared/types';
import type { WebhookSettings, WebhookFormat } from '../shared/types/settings';
import { isWebhookFormat } from '../shared/utils/webhook-format';
import { DEFAULT_APP_SETTINGS } from '../shared/constants/config';
import { parseEnvFile } from './ipc-handlers/utils';
import { validateProjectWebhookUrl } from './task-webhook-core';
import { hashWebhookUrl, isWebhookUrlApproved, type WebhookApprovals } from './project-webhook-approval';

export const WEBHOOK_ENV_KEYS = {
  ENABLED: 'WEBHOOK_ENABLED',
  URL: 'WEBHOOK_URL',
  FORMAT: 'WEBHOOK_FORMAT',
  EVENT_REVIEW_READY: 'WEBHOOK_EVENT_REVIEW_READY',
  EVENT_FAILED: 'WEBHOOK_EVENT_FAILED',
  EVENT_BLOCKED: 'WEBHOOK_EVENT_BLOCKED',
  EVENT_PR_OPENED: 'WEBHOOK_EVENT_PR_OPENED'
} as const;

const EVENT_KEY_MAP: Array<[keyof WebhookSettings['events'], string]> = [
  ['reviewReady', WEBHOOK_ENV_KEYS.EVENT_REVIEW_READY],
  ['failed', WEBHOOK_ENV_KEYS.EVENT_FAILED],
  ['blocked', WEBHOOK_ENV_KEYS.EVENT_BLOCKED],
  ['prOpened', WEBHOOK_ENV_KEYS.EVENT_PR_OPENED]
];

/** Merge WEBHOOK_EVENT_* vars over the default event toggles. */
export function parseWebhookEvents(vars: Record<string, string>): WebhookSettings['events'] {
  const events = { ...DEFAULT_APP_SETTINGS.webhook.events };
  for (const [name, key] of EVENT_KEY_MAP) {
    const value = vars[key]?.trim().toLowerCase();
    if (value === 'true') events[name] = true;
    else if (value === 'false') events[name] = false;
  }
  return events;
}

/** WEBHOOK_FORMAT -> explicit format; 'auto', missing or invalid -> undefined (auto-detect). */
export function parseWebhookFormat(vars: Record<string, string>): WebhookFormat | undefined {
  const value = vars[WEBHOOK_ENV_KEYS.FORMAT]?.trim().toLowerCase();
  return isWebhookFormat(value) ? value : undefined;
}

export interface ProjectWebhookDescriptor {
  url: string;
  /** hashWebhookUrl(url), safe to log or send to the renderer */
  hash: string;
  events: WebhookSettings['events'];
  /** Explicit payload format; undefined means detect from the URL */
  format?: WebhookFormat;
  /** approved: user approved this exact URL; unapproved: valid but not approved; refused: failed project URL validation */
  status: 'approved' | 'unapproved' | 'refused';
}

export function getProjectWebhookConfig(
  project: Pick<Project, 'path' | 'autoBuildPath'>,
  approvals?: WebhookApprovals
): ProjectWebhookDescriptor | null {
  try {
    if (!project.autoBuildPath) return null;
    const envPath = path.join(project.path, project.autoBuildPath, '.env');
    if (!existsSync(envPath)) return null;

    const vars = parseEnvFile(readFileSync(envPath, 'utf-8'));
    if (vars[WEBHOOK_ENV_KEYS.ENABLED]?.trim().toLowerCase() === 'false') return null;
    const url = (vars[WEBHOOK_ENV_KEYS.URL] ?? '').trim();
    if (!url || /[\r\n]/.test(url)) return null;
    const events = parseWebhookEvents(vars);
    const hash = hashWebhookUrl(url);
    const format = parseWebhookFormat(vars);
    if (!validateProjectWebhookUrl(url).ok) return { url, hash, events, format, status: 'refused' };
    return { url, hash, events, format, status: isWebhookUrlApproved(url, approvals) ? 'approved' : 'unapproved' };
  } catch {
    return null;
  }
}
