import { describe, expect, it } from 'vitest';
import {
  detectWebhookFormat,
  isWebhookFormat,
  resolveWebhookFormat
} from '../../shared/utils/webhook-format';

describe('detectWebhookFormat', () => {
  it.each([
    ['https://hooks.slack.com/services/T/B/X', 'slack'],
    ['https://discord.com/api/webhooks/1/abc', 'discord'],
    ['https://discordapp.com/api/webhooks/1/abc', 'discord'],
    ['https://canary.discord.com/api/webhooks/1/abc', 'discord'],
    ['https://ptb.discord.com/api/webhooks/1/abc', 'discord'],
    ['https://discord.com/api/webhooks/1/abc/slack', 'slack'],
    ['https://contoso.webhook.office.com/webhookb2/abc', 'teams'],
    ['https://outlook.office.com/webhook/abc', 'teams'],
    ['https://prod-12.westus.logic.azure.com/workflows/abc/triggers/manual', 'teams'],
    ['https://x.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/1', 'teams'],
    ['https://hooks.example.com/services/x', 'slack'],
    ['not a url', 'slack'],
    ['', 'slack'],
    ['https://hooks.slack.com.evil.example/x', 'slack'],
    ['https://evil.example/discord.com/api/webhooks/1/a', 'slack'],
    ['https://evil.example/x.webhook.office.com/', 'slack'],
    ['https://notdiscord.com/api/webhooks/1/a', 'slack'],
    ['https://evildiscord.com/api/webhooks/1/a', 'slack'],
    ['https://discord.com.evil.example/api/webhooks/1/a', 'slack'],
    ['https://evil.logic.azure.com.example/workflows/a', 'slack'],
    ['https://prod.logic.azure.com/other/a', 'slack']
  ])('detects %s as %s', (url, expected) => {
    expect(detectWebhookFormat(url)).toBe(expected);
  });
});

describe('resolveWebhookFormat', () => {
  const discord = 'https://discord.com/api/webhooks/1/abc';
  it('lets an explicit valid format beat detection', () => {
    expect(resolveWebhookFormat(discord, 'teams')).toBe('teams');
    expect(resolveWebhookFormat('https://hooks.slack.com/x', 'discord')).toBe('discord');
  });
  it.each([undefined, 'auto', 'bogus', ''])('detects for %s', (f) => {
    expect(resolveWebhookFormat(discord, f)).toBe('discord');
  });
  it('isWebhookFormat guards values', () => {
    expect(isWebhookFormat('teams')).toBe(true);
    expect(isWebhookFormat('auto')).toBe(false);
    expect(isWebhookFormat(1)).toBe(false);
  });
});
