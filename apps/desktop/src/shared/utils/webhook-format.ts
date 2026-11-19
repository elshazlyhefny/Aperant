/**
 * zeenha fork: webhook payload format detection (Slack, Microsoft Teams, Discord).
 * Dependency-free so it can be used from main and renderer. Hosts are compared
 * exactly or by suffix on a dot boundary, never by substring.
 */

export const WEBHOOK_FORMATS = ['slack', 'teams', 'discord'] as const;

export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

export function isWebhookFormat(value: unknown): value is WebhookFormat {
  return typeof value === 'string' && (WEBHOOK_FORMATS as readonly string[]).includes(value);
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export function detectWebhookFormat(url: string): WebhookFormat {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'slack';
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const path = parsed.pathname;

  if (host === 'hooks.slack.com') return 'slack';

  if (hostMatches(host, 'discord.com') || hostMatches(host, 'discordapp.com')) {
    const sub = host.replace(/\.?(discord|discordapp)\.com$/, '');
    const knownSub = sub === '' || sub === 'www' || sub === 'canary' || sub === 'ptb';
    if (knownSub && path.startsWith('/api/webhooks/')) {
      // The Slack-compatible Discord endpoint keeps receiving the Slack body.
      return /\/slack\/?$/.test(path) ? 'slack' : 'discord';
    }
    return 'slack';
  }

  if (hostMatches(host, 'webhook.office.com')) return 'teams';
  if (host === 'outlook.office.com' && path.startsWith('/webhook')) return 'teams';

  if (hostMatches(host, 'logic.azure.com') && path.startsWith('/workflows/')) return 'teams';
  if (hostMatches(host, 'powerplatform.com') && path.startsWith('/powerautomate/')) return 'teams';

  return 'slack';
}

export function resolveWebhookFormat(url: string, format?: string): WebhookFormat {
  if (isWebhookFormat(format)) return format;
  return detectWebhookFormat(url);
}
