/**
 * Shared contracts for the usage monitor modules.
 */

import type { ClaudeUsageSnapshot } from '../../../shared/types/agent';
import type { ApiProvider } from '../../../shared/utils/provider-detection';

/**
 * Result of determining the active profile type
 */
export interface ActiveProfileResult {
  profileId: string;
  profileName: string;
  profileEmail?: string;
  isAPIProfile: boolean;
  baseUrl: string;
  credential?: string;
}

/**
 * Per-provider description of how to fetch and normalize usage data.
 */
export interface UsageProviderAdapter {
  provider: ApiProvider;
  /** Path appended to the profile base URL to reach the usage endpoint */
  usagePath: string;
  /** Domains that outbound usage requests are allowed to reach */
  allowedDomains: readonly string[];
  /**
   * Provider-specific extra headers only; Authorization and Content-Type
   * are added by the caller.
   */
  buildHeaders(credential: string): Promise<Record<string, string>> | Record<string, string>;
  /** Unwrap the response payload (e.g. a `data` envelope) */
  // biome-ignore lint/suspicious/noExplicitAny: provider responses are untyped JSON
  extractData(raw: any): any;
  /** Convert provider data to a usage snapshot, or null if unusable */
  normalize(
    // biome-ignore lint/suspicious/noExplicitAny: provider responses are untyped JSON
    data: any,
    ids: { profileId: string; profileName: string; profileEmail?: string },
    // biome-ignore lint/suspicious/noExplicitAny: provider responses are untyped JSON
    raw: any
  ): ClaudeUsageSnapshot | null;
}

/**
 * Outcome of a provider usage fetch. Auth failures are not represented here;
 * they remain thrown errors carrying a statusCode.
 */
export type ProviderUsageOutcome =
  | { kind: 'ok'; usage: ClaudeUsageSnapshot }
  | { kind: 'rate-limited' }
  /** `cooldown` tells the caller whether to start the API-failure retry cooldown */
  | { kind: 'failed'; cooldown: boolean }
  | { kind: 'unsupported' };
