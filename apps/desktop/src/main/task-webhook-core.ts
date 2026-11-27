/**
 * Electron-free core of the task-outcome webhook (Slack-compatible JSON body).
 *
 * Security: payloads are built from an allow-list of fields only; the URL,
 * request body and response body are never logged; nothing here throws.
 * Keep this module free of Electron and desktop settings/logging dependencies.
 */

import { createHmac } from 'node:crypto';
import type { DeliveryResult } from '../shared/types/delivery-receipt';
import { sanitizeUrl } from './ipc-handlers/shared/sanitize';
import {
  detectWebhookFormat,
  resolveWebhookFormat,
  type WebhookFormat
} from '../shared/utils/webhook-format';

// zeenha fork: account_required is a resumable pause (no usable account for a
// phase's provider), reported apart from failed so receivers do not see a failure.
export type WebhookEvent = 'review_ready' | 'failed' | 'blocked' | 'account_required' | 'pr_opened';

export interface SlackWebhookPayload {
  text: string;
  blocks: unknown[];
}

// zeenha fork: Microsoft Teams (Adaptive Card) and Discord (embed) payloads
export interface TeamsAdaptiveCard {
  $schema: string;
  type: 'AdaptiveCard';
  version: string;
  body: unknown[];
  actions?: Array<{ type: 'Action.OpenUrl'; title: string; url: string }>;
}

export interface TeamsWebhookPayload {
  type: 'message';
  attachments: Array<{
    contentType: 'application/vnd.microsoft.card.adaptive';
    contentUrl: null;
    content: TeamsAdaptiveCard;
  }>;
}

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  url?: string;
  fields: DiscordEmbedField[];
}

export interface DiscordWebhookPayload {
  embeds: DiscordEmbed[];
  allowed_mentions: { parse: string[] };
}

export type WebhookPayload = SlackWebhookPayload | TeamsWebhookPayload | DiscordWebhookPayload;

export { detectWebhookFormat, resolveWebhookFormat };

export const MAX_URL_LENGTH = 2048;
export const MAX_TITLE_LENGTH = 200;
export const MAX_ATTEMPTS = 3;
export const TIMEOUT_MS = 10000;
export const BASE_DELAY_MS = 500;

export const EVENT_LABELS: Record<WebhookEvent, { event: string; outcome: string }> = {
  review_ready: { event: 'Ready for review', outcome: 'Completed' },
  failed: { event: 'Failed', outcome: 'Error' },
  blocked: { event: 'Blocked', outcome: 'Needs attention' },
  account_required: { event: 'Paused', outcome: 'Waiting for an account to be connected' },
  pr_opened: { event: 'PR opened', outcome: 'Awaiting review' }
};

export function validateWebhookUrl(url: string): { ok: boolean; error?: string } {
  if (typeof url !== 'string' || url.length === 0) return { ok: false, error: 'invalid_url' };
  if (url.length > MAX_URL_LENGTH) return { ok: false, error: 'url_too_long' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'invalid_url' };
  }
  if (parsed.username || parsed.password) return { ok: false, error: 'credentials_not_allowed' };
  if (parsed.protocol === 'https:') return { ok: true };
  if (parsed.protocol === 'http:') {
    const host = parsed.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return { ok: true };
    return { ok: false, error: 'https_required' };
  }
  return { ok: false, error: 'unsupported_protocol' };
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '[::1]' || host === '::1' || host === '0.0.0.0') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * zeenha fork: stricter check for a project-declared webhook URL (untrusted,
 * may come from a committed file). Refuses loopback hosts and plain http, so a
 * repository cannot make the app POST to local services. The app-wide Settings
 * webhook keeps using validateWebhookUrl, which still allows loopback.
 */
export function validateProjectWebhookUrl(url: string): { ok: boolean; error?: string } {
  const base = validateWebhookUrl(url);
  if (!base.ok) return base;
  const parsed = new URL(url);
  if (isLoopbackHost(parsed.hostname)) return { ok: false, error: 'loopback_not_allowed' };
  if (parsed.protocol !== 'https:') return { ok: false, error: 'https_required' };
  return { ok: true };
}

export function sanitizeText(value: string, max: number): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping control chars
  const cleaned = String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

export function escapeMrkdwn(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** zeenha fork: escape Markdown control characters for Discord and Teams text. */
export function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_~|>#[\]()<]/g, '\\$&');
}

interface WebhookBuildInput {
  projectName: string;
  taskTitle: string;
  event: WebhookEvent;
  prUrl?: string;
}

export function buildWebhookPayload(input: WebhookBuildInput & { format?: 'slack' }): SlackWebhookPayload;
export function buildWebhookPayload(input: WebhookBuildInput & { format: 'teams' }): TeamsWebhookPayload;
export function buildWebhookPayload(input: WebhookBuildInput & { format: 'discord' }): DiscordWebhookPayload;
export function buildWebhookPayload(input: WebhookBuildInput & { format?: WebhookFormat }): WebhookPayload;
export function buildWebhookPayload(input: WebhookBuildInput & { format?: WebhookFormat }): WebhookPayload {
  if (input.format === 'teams') return buildTeamsPayload(input);
  if (input.format === 'discord') return buildDiscordPayload(input);
  return buildSlackPayload(input);
}

function httpsLink(input: WebhookBuildInput): string {
  // Only the pr_opened event carries a link, and only an https one.
  const link = input.event === 'pr_opened' ? sanitizeUrl(input.prUrl) : '';
  return link.startsWith('https://') ? link : '';
}

function buildTeamsPayload(input: WebhookBuildInput): TeamsWebhookPayload {
  const labels = EVENT_LABELS[input.event];
  const project = escapeMarkdown(sanitizeText(input.projectName, MAX_TITLE_LENGTH));
  const title = escapeMarkdown(sanitizeText(input.taskTitle, MAX_TITLE_LENGTH));
  const link = httpsLink(input);
  const content: TeamsAdaptiveCard = {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    body: [
      { type: 'TextBlock', text: labels.event, weight: 'Bolder', size: 'Medium' },
      { type: 'TextBlock', text: title, wrap: true },
      {
        type: 'FactSet',
        facts: [
          { title: 'Project', value: project },
          { title: 'Outcome', value: labels.outcome }
        ]
      }
    ]
  };
  if (link) content.actions = [{ type: 'Action.OpenUrl', title: 'View PR', url: link }];
  return {
    type: 'message',
    attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content }]
  };
}

const DISCORD_COLORS: Record<WebhookEvent, number> = {
  review_ready: 0x2ecc71,
  failed: 0xe74c3c,
  blocked: 0xf39c12,
  account_required: 0xf1c40f,
  pr_opened: 0x3498db
};

function buildDiscordPayload(input: WebhookBuildInput): DiscordWebhookPayload {
  const labels = EVENT_LABELS[input.event];
  const project = escapeMarkdown(sanitizeText(input.projectName, MAX_TITLE_LENGTH));
  const title = escapeMarkdown(sanitizeText(input.taskTitle, MAX_TITLE_LENGTH));
  const link = httpsLink(input);
  const fields: DiscordEmbedField[] = [
    { name: 'Project', value: project || '-', inline: true },
    { name: 'Outcome', value: labels.outcome, inline: true }
  ];
  const embed: DiscordEmbed = {
    title: labels.event,
    description: title,
    color: DISCORD_COLORS[input.event],
    fields
  };
  if (link) {
    fields.push({ name: 'Pull request', value: link });
    embed.url = link;
  }
  return { embeds: [embed], allowed_mentions: { parse: [] } };
}

export function buildTestWebhookPayload(format: WebhookFormat = 'slack'): WebhookPayload {
  if (format === 'teams') {
    return {
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          contentUrl: null,
          content: {
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            type: 'AdaptiveCard',
            version: '1.4',
            body: [
              { type: 'TextBlock', text: 'Test notification', weight: 'Bolder', size: 'Medium' },
              { type: 'TextBlock', text: 'This is a test message from Aperant.', wrap: true }
            ]
          }
        }
      ]
    };
  }
  if (format === 'discord') {
    return {
      embeds: [
        {
          title: 'Test notification',
          description: 'This is a test message from Aperant.',
          color: 0x3498db,
          fields: []
        }
      ],
      allowed_mentions: { parse: [] }
    };
  }
  return {
    text: 'Aperant test notification: your webhook is configured correctly.',
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*Test notification*\nThis is a test message from Aperant.' }
      }
    ]
  };
}

function nativeUrl(url: string, format: WebhookFormat): string {
  if (format !== 'discord') return url;
  try {
    const parsed = new URL(url);
    parsed.pathname = parsed.pathname.replace(/\/(slack|github)\/?$/, '');
    return parsed.toString();
  } catch {
    return url;
  }
}

export function prepareWebhookDelivery(
  input: WebhookBuildInput & { url: string; format?: string }
): { url: string; payload: WebhookPayload; format: WebhookFormat } {
  const format = resolveWebhookFormat(input.url, input.format);
  const payload = buildWebhookPayload({
    projectName: input.projectName,
    taskTitle: input.taskTitle,
    event: input.event,
    prUrl: input.prUrl,
    format
  });
  return { url: nativeUrl(input.url, format), payload, format };
}

export function prepareTestWebhookDelivery(
  url: string,
  format?: string
): { url: string; payload: WebhookPayload; format: WebhookFormat } {
  const resolved = resolveWebhookFormat(url, format);
  return { url: nativeUrl(url, resolved), payload: buildTestWebhookPayload(resolved), format: resolved };
}

function buildSlackPayload(input: WebhookBuildInput): SlackWebhookPayload {
  const labels = EVENT_LABELS[input.event];
  const project = escapeMrkdwn(sanitizeText(input.projectName, MAX_TITLE_LENGTH));
  const title = escapeMrkdwn(sanitizeText(input.taskTitle, MAX_TITLE_LENGTH));
  // Only the pr_opened event carries a link, and only an https one.
  const link = input.event === 'pr_opened' ? sanitizeUrl(input.prUrl) : '';
  const hasLink = link.startsWith('https://');
  const baseText = `Aperant task ${labels.event.toLowerCase()}: ${title} (${project})`;
  const text = hasLink ? `${baseText} ${escapeMrkdwn(link)}` : baseText;
  const blocks: unknown[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${labels.event}*\n${title}` } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Project*\n${project}` },
        { type: 'mrkdwn', text: `*Outcome*\n${labels.outcome}` }
      ]
    }
  ];
  if (hasLink) {
    blocks.push({
      type: 'actions',
      elements: [{ type: 'button', text: { type: 'plain_text', text: 'View PR' }, url: link }]
    });
  }
  return { text, blocks };
}

export const WEBHOOK_TIMESTAMP_HEADER = 'X-Aperant-Timestamp';
export const WEBHOOK_SIGNATURE_HEADER = 'X-Aperant-Signature';

/** HMAC-SHA256 over `${timestamp}.${body}`, returned as `sha256=<hex>`. */
export function signWebhookBody(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WebhookSendOptions {
  delay?: (ms: number) => Promise<void>;
  eventName?: string;
  warn?: (message: string) => void;
  secret?: string;
  now?: () => number;
}

type WebhookSendResult = Exclude<DeliveryResult, { status: 'skipped' }>;

export async function sendWebhook(
  url: string,
  payload: WebhookPayload,
  options: WebhookSendOptions = {}
): Promise<boolean> {
  return (await sendWebhookDetailed(url, payload, options)).status === 'delivered';
}

/** zeenha fork: classify the existing retry loop without exposing response bodies or errors. */
export async function sendWebhookDetailed(
  url: string,
  payload: WebhookPayload,
  options: WebhookSendOptions = {}
): Promise<WebhookSendResult> {
  const delay = options.delay ?? defaultDelay;
  const now = options.now ?? Date.now;
  const secret = typeof options.secret === 'string' && options.secret.length > 0 ? options.secret : '';
  const eventName = options.eventName ?? 'unknown';
  const warn = (message: string): void => {
    try {
      options.warn?.(message);
    } catch {
      // never throw from logging
    }
  };
  let ambiguous: Extract<WebhookSendResult, { status: 'unknown' }> | undefined;
  let lastRejection: Extract<WebhookSendResult, { status: 'failed' }> | undefined;
  let attempts = 0;
  try {
    const body = JSON.stringify(payload);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      attempts = attempt;
      let detail: string;
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (secret) {
          // Fresh timestamp per attempt so a retry is not stale for the receiver.
          const timestamp = String(Math.floor(now() / 1000));
          headers[WEBHOOK_TIMESTAMP_HEADER] = timestamp;
          headers[WEBHOOK_SIGNATURE_HEADER] = signWebhookBody(secret, timestamp, body);
        }
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
          redirect: 'error'
        });
        const status = res.status;
        detail = `HTTP ${status}`;
        const httpStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
        if (httpStatus !== undefined && httpStatus >= 200 && httpStatus < 300) {
          return { status: 'delivered', attempts, httpStatus };
        }
        if (httpStatus === 408) {
          ambiguous ??= { status: 'unknown', reason: 'timeout', httpStatus };
        } else if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500) {
          lastRejection = { status: 'failed', reason: httpStatus === 429 ? 'rate_limited' : 'rejected', httpStatus };
        } else {
          // A server/proxy error or unexpected response need not mean the receiver rejected the POST.
          ambiguous ??= {
            status: 'unknown',
            reason: 'ambiguous_response',
            ...(httpStatus !== undefined && { httpStatus })
          };
        }
      } catch (err) {
        detail = err instanceof Error ? err.name : 'UnknownError';
        ambiguous ??= { status: 'unknown', reason: detail === 'TimeoutError' ? 'timeout' : 'transport_error' };
      }
      warn(`[Webhook] delivery failed event=${eventName} attempt=${attempt}/${MAX_ATTEMPTS} reason=${detail}`);
      if (attempt < MAX_ATTEMPTS) {
        try {
          await delay(BASE_DELAY_MS * 2 ** (attempt - 1));
        } catch {
          // ignore
        }
      }
    }
  } catch {
    ambiguous ??= { status: 'unknown', reason: 'unconfirmed' };
  }
  // A refusal on a later attempt does not disprove an earlier ambiguous send.
  const result: WebhookSendResult = ambiguous ?? lastRejection ?? { status: 'unknown', reason: 'unconfirmed' };
  return attempts > 0 ? { ...result, attempts } : result;
}
