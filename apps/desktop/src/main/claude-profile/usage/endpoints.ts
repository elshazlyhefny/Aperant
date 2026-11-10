/**
 * Usage endpoint construction and provider detection.
 */

import { detectProvider as sharedDetectProvider, type ApiProvider } from '../../../shared/utils/provider-detection';
import { USAGE_PROVIDER_ADAPTERS, getUsageProviderAdapter } from './providers/registry';

/**
 * Get usage endpoint URL for a provider
 * Constructs full usage endpoint URL from provider baseUrl and usage path
 *
 * @param provider - The provider type
 * @param baseUrl - The API base URL (e.g., 'https://api.z.ai/api/anthropic')
 * @returns Full usage endpoint URL or null if provider unknown
 *
 * @example
 * getUsageEndpoint('anthropic', 'https://api.anthropic.com')
 * // returns 'https://api.anthropic.com/api/oauth/usage'
 * getUsageEndpoint('zai', 'https://api.z.ai/api/anthropic')
 * // returns 'https://api.z.ai/api/monitor/usage/quota/limit'
 * getUsageEndpoint('unknown', 'https://example.com')
 * // returns null
 */
export function getUsageEndpoint(provider: ApiProvider, baseUrl: string): string | null {
  const isVerbose = process.env.VERBOSE === 'true';

  if (isVerbose) {
    console.warn('[UsageMonitor:ENDPOINT_CONSTRUCTION] Constructing usage endpoint:', {
      provider,
      baseUrl
    });
  }

  const endpointConfig = getUsageProviderAdapter(provider);
  if (!endpointConfig) {
    if (isVerbose) {
      console.warn('[UsageMonitor:ENDPOINT_CONSTRUCTION] Unknown provider - no endpoint configured:', {
        provider,
        availableProviders: USAGE_PROVIDER_ADAPTERS.map(a => a.provider)
      });
    }
    return null;
  }

  if (isVerbose) {
    console.warn('[UsageMonitor:ENDPOINT_CONSTRUCTION] Found endpoint config for provider:', {
      provider,
      usagePath: endpointConfig.usagePath
    });
  }

  try {
    const url = new URL(baseUrl);
    const originalPath = url.pathname;
    // Replace the path with the usage endpoint path
    url.pathname = endpointConfig.usagePath;

    // Note: quota/limit endpoint doesn't require query parameters
    // The model-usage and tool-usage endpoints would need time windows, but we're using quota/limit

    const finalUrl = url.toString();

    if (isVerbose) {
      console.warn('[UsageMonitor:ENDPOINT_CONSTRUCTION] Successfully constructed endpoint:', {
        provider,
        originalPath,
        newPath: endpointConfig.usagePath,
        finalUrl
      });
    }

    return finalUrl;
  } catch (error) {
    console.error('[UsageMonitor] Invalid baseUrl for usage endpoint:', baseUrl);
    if (isVerbose) {
      console.warn('[UsageMonitor:ENDPOINT_CONSTRUCTION] URL construction failed:', {
        baseUrl,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return null;
  }
}

/**
 * Detect API provider from baseUrl
 * Extracts domain and matches against known provider patterns
 *
 * @param baseUrl - The API base URL (e.g., 'https://api.z.ai/api/anthropic')
 * @returns The detected provider type ('anthropic' | 'zai' | 'zhipu' | 'unknown')
 *
 * @example
 * detectProvider('https://api.anthropic.com') // returns 'anthropic'
 * detectProvider('https://api.z.ai/api/anthropic') // returns 'zai'
 * detectProvider('https://open.bigmodel.cn/api/anthropic') // returns 'zhipu'
 * detectProvider('https://unknown.com/api') // returns 'unknown'
 */
export function detectProvider(baseUrl: string): ApiProvider {
  // Wrapper around shared detectProvider with verbose logging for main process
  const isVerbose = process.env.VERBOSE === 'true';

  const provider = sharedDetectProvider(baseUrl);

  if (isVerbose) {
    console.warn('[UsageMonitor:PROVIDER_DETECTION] Detected provider:', {
      baseUrl,
      provider
    });
  }

  return provider;
}
