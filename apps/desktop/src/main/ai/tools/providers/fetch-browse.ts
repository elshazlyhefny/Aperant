/**
 * Fetch Browse Provider
 * =====================
 *
 * BrowseProvider implementation using native fetch().
 * Returns raw HTML content — no markdown conversion.
 * Used as a fallback when Jina is unavailable.
 */

import { validateFetchUrl } from '../../security/url-policy';
import type { BrowseOptions, BrowseProvider, BrowseResult } from './types';

const DEFAULT_TIMEOUT = 30_000;
const MAX_CONTENT_LENGTH = 100_000;
const MAX_REDIRECTS = 5;

export class FetchBrowseProvider implements BrowseProvider {
  readonly name = 'fetch';

  async browse(url: string, options?: BrowseOptions): Promise<BrowseResult> {
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      // Redirects are followed by hand so every hop passes the URL policy.
      // Global fetch cannot pin the IP that the policy resolved, so DNS
      // rebinding is reduced (each hop is re-resolved) but not eliminated.
      // Only User-Agent/Accept are sent, so no header needs dropping on a
      // cross-origin hop.
      let currentUrl = url;
      let response: Response | undefined;

      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const policy = await validateFetchUrl(currentUrl);
        if (!policy.ok) {
          throw new Error(
            hop === 0 ? `URL blocked — ${policy.reason}` : `Redirect blocked — ${policy.reason}`,
          );
        }

        response = await fetch(policy.url.href, {
          signal: controller.signal,
          redirect: 'manual',
          headers: {
            'User-Agent': 'AutoClaude/1.0',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location) break;
          if (hop === MAX_REDIRECTS) {
            throw new Error(`Too many redirects (more than ${MAX_REDIRECTS})`);
          }
          try {
            currentUrl = new URL(location, policy.url).href;
          } catch {
            throw new Error('Redirect blocked — Location header is not a valid URL');
          }
          continue;
        }
        break;
      }

      if (!response) {
        throw new Error('No response received');
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      let content = await response.text();

      if (content.length > MAX_CONTENT_LENGTH) {
        content = `${content.slice(0, MAX_CONTENT_LENGTH)}\n\n[Content truncated — ${content.length} characters total]`;
      }

      return { url, content };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
