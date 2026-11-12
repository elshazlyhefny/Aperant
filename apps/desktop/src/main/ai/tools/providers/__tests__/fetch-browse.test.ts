import { describe, it, expect, vi, beforeEach } from 'vitest';

import { FetchBrowseProvider } from '../fetch-browse';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function ok(body: string) {
  return { ok: true, status: 200, statusText: 'OK', headers: new Headers(), text: () => Promise.resolve(body) };
}

function redirect(location: string | null, status = 302) {
  const headers = new Headers();
  if (location) headers.set('location', location);
  return { ok: false, status, statusText: 'Found', headers, text: () => Promise.resolve('') };
}

describe('FetchBrowseProvider', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should request with redirect: manual', async () => {
    mockFetch.mockResolvedValueOnce(ok('<html>hi</html>'));
    const result = await new FetchBrowseProvider().browse('https://example.com/');
    expect(result.content).toBe('<html>hi</html>');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com/',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('should follow a safe redirect', async () => {
    mockFetch
      .mockResolvedValueOnce(redirect('/next'))
      .mockResolvedValueOnce(ok('final'));
    const result = await new FetchBrowseProvider().browse('https://example.com/start');
    expect(result.content).toBe('final');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][0]).toBe('https://example.com/next');
  });

  it.each(['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/'])(
    'should refuse a redirect to %s',
    async (target) => {
      mockFetch.mockResolvedValueOnce(redirect(target));
      await expect(new FetchBrowseProvider().browse('https://example.com/')).rejects.toThrow(
        'Redirect blocked',
      );
      expect(mockFetch).toHaveBeenCalledTimes(1);
    },
  );

  it('should refuse a redirect whose Location carries a secret', async () => {
    const secret = `ghp_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}`;
    mockFetch.mockResolvedValueOnce(redirect(`https://attacker.test/?t=${secret}`));
    await expect(new FetchBrowseProvider().browse('https://example.com/')).rejects.toThrow(
      'Redirect blocked',
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('should stop after 5 hops', async () => {
    mockFetch.mockResolvedValue(redirect('https://example.com/loop'));
    await expect(new FetchBrowseProvider().browse('https://example.com/')).rejects.toThrow(
      'Too many redirects',
    );
    expect(mockFetch).toHaveBeenCalledTimes(6);
  });

  it('should refuse an internal initial URL', async () => {
    await expect(new FetchBrowseProvider().browse('http://localhost:3000')).rejects.toThrow(
      'blocked',
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should truncate long content', async () => {
    mockFetch.mockResolvedValueOnce(ok('a'.repeat(150_000)));
    const result = await new FetchBrowseProvider().browse('https://example.com/');
    expect(result.content).toContain('[Content truncated — 150000 characters total]');
    expect(result.content.length).toBeLessThan(101_000);
  });

  it('should throw on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 404, statusText: 'Not Found', headers: new Headers(), text: () => Promise.resolve(''),
    });
    await expect(new FetchBrowseProvider().browse('https://example.com/')).rejects.toThrow('HTTP 404');
  });
});
