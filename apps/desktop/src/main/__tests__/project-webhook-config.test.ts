import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { getProjectWebhookConfig, WEBHOOK_ENV_KEYS } from '../project-webhook-config';

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

  it('exposes all six env keys', () => {
    expect(Object.values(WEBHOOK_ENV_KEYS).sort()).toEqual(
      [
        'WEBHOOK_ENABLED',
        'WEBHOOK_URL',
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
      events: { reviewReady: true, failed: true, blocked: true, prOpened: false }
    });
  });

  it('allows http only on loopback', () => {
    writeEnv('WEBHOOK_URL=http://localhost:8080/hook\n');
    expect(getProjectWebhookConfig(project())?.url).toBe('http://localhost:8080/hook');
    writeEnv('WEBHOOK_URL=http://hooks.example.com/x\n');
    expect(getProjectWebhookConfig(project())).toBeNull();
  });

  it('rejects URLs with credentials', () => {
    writeEnv('WEBHOOK_URL=https://user:pass@hooks.example.com/x\n');
    expect(getProjectWebhookConfig(project())).toBeNull();
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
    writeEnv('WEBHOOK_URL="https://hooks.example.com/x\r\nEVIL=1"\n');
    expect(getProjectWebhookConfig(project())).toBeNull();
  });
});
