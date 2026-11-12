/**
 * Provider Factory
 * ================
 *
 * Factory functions for creating search and browse providers.
 * Tools import from here — they never import provider implementations directly.
 */

export type { SearchProvider, SearchResult, SearchOptions, BrowseProvider, BrowseResult, BrowseOptions } from './types';

export { SerperSearchProvider } from './serper-search';
export { TavilySearchProvider } from './tavily-search';
export { JinaBrowseProvider } from './jina-browse';
export { FetchBrowseProvider } from './fetch-browse';

import type { SearchProvider } from './types';
import type { BrowseProvider } from './types';
import { SerperSearchProvider } from './serper-search';
import { JinaBrowseProvider } from './jina-browse';
import { FetchBrowseProvider } from './fetch-browse';

/**
 * Create the default search provider.
 * Uses Serper.dev with an embedded API key — search works out of the box.
 */
export function createSearchProvider(): SearchProvider {
  return new SerperSearchProvider();
}

/**
 * Create the browse provider.
 * 'jina' (default) relays via Jina Reader; 'direct' fetches locally with native fetch.
 */
export function createBrowseProvider(mode: 'jina' | 'direct' = 'jina'): BrowseProvider {
  return mode === 'direct' ? new FetchBrowseProvider() : new JinaBrowseProvider();
}
