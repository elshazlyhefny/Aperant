import { describe, expect, it } from 'vitest';
import { isBlockedIp, validateFetchUrl } from '../url-policy';

const pub = async () => [{ address: '93.184.216.34', family: 4 }];
const check = (u: string, resolve = pub) => validateFetchUrl(u, { resolve });

describe('validateFetchUrl rejects', () => {
  const cases: Array<[string, string]> = [
    ['file', 'file:///etc/passwd'],
    ['ftp', 'ftp://example.com/x'],
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/plain,hi'],
    ['credentials', 'https://user:pw@example.com/'],
    ['localhost', 'http://localhost:3000/'],
    ['sub.localhost', 'http://a.localhost/'],
    ['loopback', 'http://127.0.0.1/'],
    ['short loopback', 'http://127.1/'],
    ['decimal loopback', 'http://2130706433/'],
    ['hex loopback', 'http://0x7f000001/'],
    ['ipv6 loopback', 'http://[::1]/'],
    ['unspecified', 'http://0.0.0.0/'],
    ['10/8', 'http://10.1.2.3/'],
    ['172.16/12', 'http://172.16.0.1/'],
    ['192.168/16', 'http://192.168.1.1/'],
    ['metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['cgnat', 'http://100.64.0.1/'],
    ['link-local v6', 'http://[fe80::1]/'],
    ['unique-local v6', 'http://[fc00::1]/'],
    ['mapped loopback', 'http://[::ffff:127.0.0.1]/'],
    ['.local', 'http://foo.local/'],
    ['.internal', 'http://db.internal/'],
    ['single label', 'http://intranet/'],
    ['too long', `https://example.com/${'a'.repeat(2100)}`],
    ['sk-ant query', `https://example.com/?q=sk-ant-${'a1'.repeat(15)}`],
    ['ghp query', `https://example.com/?q=ghp_${'a'.repeat(36)}`],
    ['aws key', 'https://example.com/?q=AKIAABCDEFGHIJKLMNOP'],
    ['token param', 'https://example.com/?token=abcdefghijklmnopqrstuvwx'],
    ['secret in path', `https://example.com/ghp_${'b'.repeat(36)}/x`],
    ['secret in subdomain', `https://ghp_${'c'.repeat(36)}.example.com/`],
    ['encoded secret', `https://example.com/?q=%67hp_${'d'.repeat(36)}`],
    ['example domain secret', `https://example.com/example?k=ghp_${'e'.repeat(36)}`],
    ['presigned', 'https://example.com/f?X-Amz-Signature=abc'],
  ];
  for (const [name, url] of cases) {
    it(name, async () => {
      const r = await check(url);
      expect(r.ok).toBe(false);
    });
  }

  it('does not echo the secret in the reason', async () => {
    const secret = `ghp_${'f'.repeat(36)}`;
    const r = await check(`https://example.com/?q=${secret}`);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('GitHub Personal Access Token');
      expect(r.reason).not.toContain(secret);
    }
  });

  it('hostname resolving to a private IP', async () => {
    const r = await check('https://evil.example.com/', async () => [{ address: '10.0.0.5' }]);
    expect(r.ok).toBe(false);
  });

  it('mixed public and private addresses', async () => {
    const r = await check('https://evil.example.com/', async () => [
      { address: '93.184.216.34' },
      { address: '192.168.0.2' },
    ]);
    expect(r.ok).toBe(false);
  });

  it('DNS failure', async () => {
    const r = await check('https://nope.example.com/', async () => {
      throw new Error('ENOTFOUND');
    });
    expect(r.ok).toBe(false);
  });
});

describe('validateFetchUrl accepts', () => {
  it.each([
    'https://example.com/docs?page=2',
    'http://example.org',
    'https://example.com/items/123e4567-e89b-12d3-a456-426614174000',
    'http://93.184.216.34/',
  ])('%s', async (u) => {
    const r = await check(u);
    expect(r.ok).toBe(true);
  });
});

describe('isBlockedIp', () => {
  it('classifies addresses', () => {
    expect(isBlockedIp('8.8.8.8')).toBe(false);
    expect(isBlockedIp('2606:4700::1111')).toBe(false);
    expect(isBlockedIp('::ffff:8.8.8.8')).toBe(false);
    expect(isBlockedIp('::ffff:10.0.0.1')).toBe(true);
    expect(isBlockedIp('not-an-ip')).toBe(true);
  });
});
