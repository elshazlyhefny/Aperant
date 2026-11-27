import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { hashWebhookUrl } from '../project-webhook-approval';
import { getProjectWebhookConfig, parseWebhookFormat, WEBHOOK_ENV_KEYS } from '../project-webhook-config';

let root: string;
const project = () => ({ path: root, autoBuildPath: '.auto-claude' });

function writeEnv(content: string): void {
  mkdirSync(path.join(root, '.auto-claude'), { recursive: true });
  writeFileSync(path.join(root, '.auto-claude', '.env'), content);
}

describe('getProjectWebhookConfig', () => {
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'proj-webhook-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('parses WEBHOOK_FORMAT, treating auto and invalid values as undefined', () => {
    expect(parseWebhookFormat({ WEBHOOK_FORMAT: 'teams' })).toBe('teams');
    expect(parseWebhookFormat({ WEBHOOK_FORMAT: ' Discord ' })).toBe('discord');
    expect(parseWebhookFormat({ WEBHOOK_FORMAT: 'slack' })).toBe('slack');
    expect(parseWebhookFormat({ WEBHOOK_FORMAT: 'auto' })).toBeUndefined();
    expect(parseWebhookFormat({ WEBHOOK_FORMAT: 'bogus' })).toBeUndefined();
    expect(parseWebhookFormat({})).toBeUndefined();
  });

  it('fills format on the descriptor for every status', () => {
    const url = 'https://hooks.example.com/x';
    writeEnv(`WEBHOOK_URL=${url}\nWEBHOOK_FORMAT=teams\n`);
    expect(getProjectWebhookConfig(project())?.format).toBe('teams');
    expect(getProjectWebhookConfig(project(), { urls: [hashWebhookUrl(url)] })?.format).toBe('teams');
    writeEnv('WEBHOOK_URL=http://localhost/x\nWEBHOOK_FORMAT=discord\n');
    const refused = getProjectWebhookConfig(project());
    expect(refused?.status).toBe('refused');
    expect(refused?.format).toBe('discord');
    writeEnv(`WEBHOOK_URL=${url}\nWEBHOOK_FORMAT=nope\n`);
    expect(getProjectWebhookConfig(project())?.format).toBeUndefined();
  });

  it('does not change the hash or approval status when only the format changes', () => {
    const url = 'https://hooks.example.com/x';
    const approvals = { urls: [hashWebhookUrl(url)] };
    writeEnv(`WEBHOOK_URL=${url}\nWEBHOOK_FORMAT=slack\n`);
    const a = getProjectWebhookConfig(project(), approvals);
    writeEnv(`WEBHOOK_URL=${url}\nWEBHOOK_FORMAT=teams\n`);
    const b = getProjectWebhookConfig(project(), approvals);
    expect(a?.hash).toBe(b?.hash);
    expect(a?.status).toBe('approved');
    expect(b?.status).toBe('approved');
  });

  it('exposes all seven env keys', () => {
    expect(Object.values(WEBHOOK_ENV_KEYS).sort()).toEqual(
      [
        'WEBHOOK_ENABLED',
        'WEBHOOK_URL',
        'WEBHOOK_FORMAT',
        'WEBHOOK_EVENT_REVIEW_READY',
        'WEBHOOK_EVENT_FAILED',
        'WEBHOOK_EVENT_BLOCKED',
        'WEBHOOK_EVENT_PR_OPENED'
      ].sort()
    );
  });

  it('returns null without autoBuildPath or env file', () => {
    expect(getProjectWebhookConfig({ path: root, autoBuildPath: '' })).toBeNull();
    expect(getProjectWebhookConfig(project())).toBeNull();
  });

  it('returns null when disabled or URL empty', () => {
    writeEnv('WEBHOOK_ENABLED=false\nWEBHOOK_URL=https://hooks.example.com/x\n');
    expect(getProjectWebhookConfig(project())).toBeNull();
    writeEnv('WEBHOOK_ENABLED=true\n# WEBHOOK_URL=\n');
    expect(getProjectWebhookConfig(project())).toBeNull();
  });

  it('accepts a valid https URL with default events', () => {
    writeEnv('WEBHOOK_URL=https://hooks.example.com/x\n');
    expect(getProjectWebhookConfig(project())).toEqual({
      url: 'https://hooks.example.com/x',
      hash: hashWebhookUrl('https://hooks.example.com/x'),
      status: 'unapproved',
      events: { reviewReady: true, failed: true, blocked: true, prOpened: false }
    });
  });

  it('marks a URL approved when its hash is in approvals', () => {
    const url = 'https://hooks.example.com/x';
    writeEnv(`WEBHOOK_URL=${url}\n`);
    expect(getProjectWebhookConfig(project(), { urls: [hashWebhookUrl(url)] })?.status).toBe('approved');
    expect(getProjectWebhookConfig(project(), { urls: ['other'] })?.status).toBe('unapproved');
  });

  it('never exposes a WEBHOOK_SECRET from the project .env', () => {
    const url = 'https://hooks.example.com/x';
    writeEnv(`WEBHOOK_URL=${url}\nWEBHOOK_SECRET=x\n`);
    const descriptor = getProjectWebhookConfig(project(), { urls: [hashWebhookUrl(url)] });
    expect(descriptor?.status).toBe('approved');
    expect(descriptor).not.toHaveProperty('secret');
  });

  it('refuses loopback and plain http', () => {
    writeEnv('WEBHOOK_URL=http://localhost:8080/hook\n');
    expect(getProjectWebhookConfig(project())?.status).toBe('refused');
    writeEnv('WEBHOOK_URL=http://hooks.example.com/x\n');
    expect(getProjectWebhookConfig(project())?.status).toBe('refused');
  });

  it('refuses URLs with credentials, even if hash is approved', () => {
    const url = 'https://user:pass@hooks.example.com/x';
    writeEnv(`WEBHOOK_URL=${url}\n`);
    expect(getProjectWebhookConfig(project(), { urls: [hashWebhookUrl(url)] })?.status).toBe('refused');
  });

  it('applies event overrides', () => {
    writeEnv(
      'WEBHOOK_URL=https://hooks.example.com/x\nWEBHOOK_EVENT_REVIEW_READY=false\nWEBHOOK_EVENT_PR_OPENED=true\nWEBHOOK_EVENT_FAILED=false\n'
    );
    expect(getProjectWebhookConfig(project())?.events).toEqual({
      reviewReady: false,
      failed: false,
      blocked: true,
      prOpened: true
    });
  });

  it('rejects URLs containing CR/LF', () => {
    writeEnv('WEBHOOK_URL=https://hooks.example.com/x\n');
    expect(getProjectWebhookConfig(project())).not.toBeNull();
    // Escape-style value that would carry a newline after parsing
    // (the env parser splits at the newline, leaving an unterminated quoted value)
    writeEnv('WEBHOOK_URL="https://hooks.example.com/x\r\nEVIL=1"\n');
    const cfg = getProjectWebhookConfig(project());
    expect(cfg === null || cfg.status === 'refused').toBe(true);
  });
});
