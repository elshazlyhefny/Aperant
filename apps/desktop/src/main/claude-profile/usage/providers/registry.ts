/**
 * Registry of usage provider adapters.
 */

import type { ApiProvider } from '../../../../shared/utils/provider-detection';
import type { UsageProviderAdapter } from '../types';
import { anthropicAdapter } from './anthropic';
import { openaiAdapter } from './openai';
import { zaiAdapter } from './zai';
import { zhipuAdapter } from './zhipu';

export const USAGE_PROVIDER_ADAPTERS: readonly UsageProviderAdapter[] = [
  anthropicAdapter,
  openaiAdapter,
  zaiAdapter,
  zhipuAdapter
];

export function getUsageProviderAdapter(provider: ApiProvider): UsageProviderAdapter | undefined {
  return USAGE_PROVIDER_ADAPTERS.find(a => a.provider === provider);
}

/**
 * Domains permitted for outbound usage monitoring requests, derived from adapters.
 */
export function getAllowedUsageDomains(): Set<string> {
  return new Set(USAGE_PROVIDER_ADAPTERS.flatMap(a => a.allowedDomains));
}
