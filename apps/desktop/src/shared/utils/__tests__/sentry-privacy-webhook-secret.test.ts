import { describe, expect, it } from 'vitest';
import { processEvent, sanitizeForSentry } from '../sentry-privacy';
import { CREDENTIAL_ENV_PATTERNS } from '../../../main/ai/security/child-env';

const SECRET = ['whsec', 'supersecretvalue123'].join('_');
const SIGNATURE = 'sha256=0123456789abcdef';

describe('sentry-privacy webhook secret redaction', () => {
  it('redacts webhook secret key=value text', () => {
    const out = sanitizeForSentry(`failed webhook_secret=${SECRET} for hook`);
    expect(out).not.toContain(SECRET);
    expect(out).toContain('[REDACTED]');
  });

  it('redacts signature and timestamp header text', () => {
    const out = sanitizeForSentry(
      `X-Aperant-Signature: ${SIGNATURE}\nX-Aperant-Timestamp: 1700000000`
    );
    expect(out).not.toContain('0123456789abcdef');
    expect(out).not.toContain('1700000000');
  });

  it('redacts secret keys in breadcrumbs, extra and request data', () => {
    const event = processEvent({
      breadcrumbs: [{ data: { webhook: { secret: SECRET, url: 'https://x.test' } } }],
      extra: { webhook: { secret: SECRET }, webhookSecret: SECRET },
      request: {
        headers: { 'X-Aperant-Signature': SIGNATURE, Accept: 'json' },
        data: { secret: SECRET },
      },
    });
    const json = JSON.stringify(event);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain(SIGNATURE);
    expect(event.breadcrumbs?.[0].data).toEqual({
      webhook: { secret: '[REDACTED]', url: 'https://x.test' },
    });
    expect(event.request?.headers?.Accept).toBe('json');
  });

  it('child-env credential patterns match APERANT_WEBHOOK_SECRET', () => {
    expect(CREDENTIAL_ENV_PATTERNS.some((re) => re.test('APERANT_WEBHOOK_SECRET'))).toBe(true);
  });
});
