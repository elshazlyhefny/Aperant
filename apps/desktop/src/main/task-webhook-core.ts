/**
 * Electron-free core of the task-outcome webhook (Slack-compatible JSON body).
 *
 * Security: payloads are built from an allow-list of fields only; the URL,
 * request body and response body are never logged; nothing here throws.
 * Only type imports and the dependency-free sanitizer are allowed here so the
 * module can be loaded outside Electron.
 */

import { sanitizeUrl } from './ipc-handlers/shared/sanitize';
import {
  detectWebhookFormat,
  resolveWebhookFormat,
  type WebhookFormat
} from '../shared/utils/webhook-format';

export type WebhookEvent = 'review_ready' | 'failed' | 'blocked' | 'pr_opened';

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

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendWebhook(
  url: string,
  payload: WebhookPayload,
  options: {
    delay?: (ms: number) => Promise<void>;
    eventName?: string;
    warn?: (message: string) => void;
  } = {}
): Promise<boolean> {
  const delay = options.delay ?? defaultDelay;
  const eventName = options.eventName ?? 'unknown';
  const warn = (message: string): void => {
    try {
      options.warn?.(message);
    } catch {
      // never throw from logging
    }
  };
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let detail: string;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(TIMEOUT_MS),
          redirect: 'error'
        });
        if (res.status >= 200 && res.status < 300) return true;
        detail = `HTTP ${res.status}`;
      } catch (err) {
        detail = err instanceof Error ? err.name : 'UnknownError';
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
    // never throw
  }
  return false;
}
