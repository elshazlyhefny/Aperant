import { describe, expect, it } from 'vitest';
import { hashWebhookUrl, isWebhookUrlApproved } from '../project-webhook-approval';
import { validateProjectWebhookUrl, validateWebhookUrl } from '../task-webhook-core';

describe('validateProjectWebhookUrl', () => {
  it.each([
    'http://localhost/hook',
    'https://localhost/hook',
    'https://foo.localhost/hook',
    'http://127.0.0.1:8080/x',
    'https://127.5.6.7/x',
    'https://[::1]/x',
    'https://0.0.0.0/x',
  ])('refuses loopback %s', (url) => {
    expect(validateProjectWebhookUrl(url)).toEqual({ ok: false, error: 'loopback_not_allowed' });
  });

  it('refuses plain http', () => {
    expect(validateProjectWebhookUrl('http://example.com/x')).toEqual({ ok: false, error: 'https_required' });
  });

  it('propagates base validator errors', () => {
    expect(validateProjectWebhookUrl('not a url').error).toBe('invalid_url');
    expect(validateProjectWebhookUrl('https://u:p@example.com/x').error).toBe('credentials_not_allowed');
    expect(validateProjectWebhookUrl('ftp://example.com/x').error).toBe('unsupported_protocol');
  });

  it('accepts a public https URL', () => {
    expect(validateProjectWebhookUrl('https://hooks.slack.com/services/T/B/x')).toEqual({ ok: true });
  });

  it('leaves validateWebhookUrl allowing loopback', () => {
    expect(validateWebhookUrl('http://localhost:3000/x').ok).toBe(true);
  });
});

describe('webhook url hashing', () => {
  it('is deterministic sha256 hex and trims', () => {
    const h = hashWebhookUrl('https://a.example/x');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashWebhookUrl('  https://a.example/x \n')).toBe(h);
    expect(hashWebhookUrl('https://b.example/x')).not.toBe(h);
  });

  it('checks approval by hash', () => {
    const url = 'https://a.example/x';
    expect(isWebhookUrlApproved(url, undefined)).toBe(false);
    expect(isWebhookUrlApproved(url, { urls: [] })).toBe(false);
    expect(isWebhookUrlApproved(` ${url} `, { urls: [hashWebhookUrl(url)] })).toBe(true);
    expect(isWebhookUrlApproved('https://other.example', { urls: [hashWebhookUrl(url)] })).toBe(false);
  });
});
