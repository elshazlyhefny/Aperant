/**
 * Usage Monitor - Proactive usage monitoring and account switching
 *
 * Monitors Claude account usage at configured intervals and automatically
 * switches to alternative accounts before hitting rate limits.
 *
 * This file owns scheduling, caching, failover and swap decisions only.
 * Everything provider-specific lives under ./usage/:
 * - usage/providers/  per-provider adapters + registry.ts (endpoint, auth, normalization)
 * - usage/endpoints.ts, usage/usage-api-client.ts  endpoint lookup and HTTP fetch
 * - usage/credential-resolver.ts, usage/active-profile-resolver.ts  credential/profile resolution
 * - usage/availability-score.ts, usage/provider-accounts.ts, usage/usage-log.ts  scoring, provider accounts, logging
 *
 * Uses hybrid approach:
 * 1. Primary: Direct OAuth API (https://api.anthropic.com/api/oauth/usage)
 * 2. Fallback: CLI /usage command parsing
 */

import { EventEmitter } from 'events';
import { homedir } from 'os';
import { getClaudeProfileManager } from '../claude-profile-manager';
import { ClaudeUsageSnapshot, ProfileUsageSummary, AllProfilesUsage } from '../../shared/types/agent';
import { loadProfilesFile } from '../services/profile/api-profile-store';
import type { APIProfile } from '../../shared/types/profile';
import { getKeyStatus, failoverTier } from '../../shared/utils/api-key-status';
import type { ApiProvider } from '../../shared/utils/provider-detection';
import { getCredentialsFromKeychain, clearKeychainCache } from './credential-utils';
import { reactiveTokenRefresh } from './token-refresh';
import { isProfileRateLimited } from './rate-limit-manager';
import { getOperationRegistry } from './operation-registry';
import { readSettingsFileAsync } from '../settings-utils';

import { appLog } from '../app-logger';
import type { ActiveProfileResult } from './usage/types';
import { getCredentialFingerprint, createUsageLogger } from './usage/usage-log';
import { resolveActiveCredential, resolveInactiveProfileToken } from './usage/credential-resolver';
import { resolveActiveProfile, resolveActiveProfileLegacy } from './usage/active-profile-resolver';
import { calculateAvailabilityScore } from './usage/availability-score';
import { appendProviderAccountUsage, codexUsageSource, openrouterUsageSource, zaiUsageSource } from './usage/provider-accounts';
// Re-export for backward compatibility
export type { ApiProvider };

export { getUsageEndpoint, detectProvider } from './usage/endpoints';
import { getUsageEndpoint, detectProvider } from './usage/endpoints';
import { fetchProviderUsage } from './usage/usage-api-client';
import { normalizeAnthropicResponse } from './usage/providers/anthropic';
import { normalizeQuotaLimitResponse } from './usage/providers/quota-limit';



/**
 * Type guard to check if an error has an HTTP status code
 * @param error - The error to check
 * @returns true if the error has a statusCode property
 */
function isHttpError(error: unknown): error is Error & { statusCode?: number } {
  return error instanceof Error && 'statusCode' in error;
}

export class UsageMonitor extends EventEmitter {
  private static instance: UsageMonitor;
  private intervalId: NodeJS.Timeout | null = null;
  private currentUsage: ClaudeUsageSnapshot | null = null;
  private currentUsageProfileId: string | null = null; // Track which profile's usage is in currentUsage
  private isChecking = false;

  // Per-profile API failure tracking with cooldown-based retry
  // Map<profileId, lastFailureTimestamp> - stores when API last failed for this profile
  private apiFailureTimestamps: Map<string, number> = new Map();
  private static API_FAILURE_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes cooldown before API retry

  // Swap loop protection: track profiles that recently failed auth
  private authFailedProfiles: Map<string, number> = new Map(); // profileId -> timestamp
  private static AUTH_FAILURE_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes cooldown

  // Track profiles that need re-authentication (invalid refresh token)
  // These profiles have permanent auth failures that require manual re-auth
  private needsReauthProfiles: Set<string> = new Set();

  // Cache for all profiles' usage data
  // Map<profileId, { usage: ProfileUsageSummary, fetchedAt: number }>
  private allProfilesUsageCache: Map<string, { usage: ProfileUsageSummary; fetchedAt: number }> = new Map();
  private static PROFILE_USAGE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache for inactive profiles

  // Request coalescing: track in-flight getAllProfilesUsage() promise to avoid parallel duplicate fetches
  private allProfilesUsageInflight: Promise<AllProfilesUsage | null> | null = null;

  // Timestamp of last inactive-profile refresh (for adaptive cadence)
  private lastInactiveProfileRefreshAt = 0;

  // Rate-limit (429) tracking: separate from general API failures, uses longer cooldown
  private rateLimitedProfiles: Map<string, number> = new Map(); // profileId -> 429 timestamp
  private static RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes cooldown for 429s

  // Debug flag for verbose logging
  private readonly isDebug = process.env.DEBUG === 'true';
  // Verbose flag for trace-level logging (only with VERBOSE=true)
  private readonly isVerbose = process.env.VERBOSE === 'true';

  private readonly logger = createUsageLogger();
  private readonly credentialLog = {
    debugLog: (message: string, data?: unknown): void => this.debugLog(message, data),
    traceLog: (message: string, data?: unknown): void => this.traceLog(message, data)
  };

  /**
   * Debug log helper - only logs when DEBUG=true
   */
  private debugLog(message: string, data?: unknown): void {
    this.logger.debugLog(message, data);
  }

  /**
   * Trace log helper - only logs when VERBOSE=true (more granular than debug)
   */
  private traceLog(message: string, data?: unknown): void {
    this.logger.traceLog(message, data);
  }

  private constructor() {
    super();
    this.debugLog('[UsageMonitor] Initialized');
  }

  static getInstance(): UsageMonitor {
    if (!UsageMonitor.instance) {
      UsageMonitor.instance = new UsageMonitor();
    }
    return UsageMonitor.instance;
  }

  /**
   * Start monitoring usage at configured interval
   *
   * Note: Usage monitoring always runs to display the usage badge.
   * Proactive account swapping only occurs if enabled in settings.
   *
   * Update interval: 60 seconds (60000ms) for active profile; inactive profiles every 5 minutes (adaptive: 60s when usage is high)
   */
  start(): void {
    if (this.intervalId) {
      this.debugLog('[UsageMonitor] Already running');
      return;
    }

    const profileManager = getClaudeProfileManager();
    const settings = profileManager.getAutoSwitchSettings();
    const interval = settings.usageCheckInterval || 60000; // 60 seconds for active profile polling

    this.debugLog('[UsageMonitor] Starting with interval: ' + interval + ' ms (60-second updates for active profile usage stats)');

    // Check immediately
    this.checkUsageAndSwap();

    // Then check periodically
    this.intervalId = setInterval(() => {
      this.checkUsageAndSwap();
    }, interval);
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.debugLog('[UsageMonitor] Stopped');
    }
  }

  /**
   * Get current usage snapshot (for UI indicator)
   */
  getCurrentUsage(): ClaudeUsageSnapshot | null {
    return this.currentUsage;
  }

  /**
   * Clear the usage cache for a specific profile.
   * Called after re-authentication to ensure fresh usage data is fetched.
   *
   * @param profileId - Profile identifier to clear cache for
   */
  clearProfileUsageCache(profileId: string): void {
    const deleted = this.allProfilesUsageCache.delete(profileId);

    // Also clear currentUsage if it belongs to this profile
    // This prevents stale data from being displayed when getAllProfilesUsage()
    // uses this.currentUsage for the active profile
    const clearedCurrentUsage = this.currentUsageProfileId === profileId;
    if (clearedCurrentUsage) {
      this.currentUsage = null;
      this.currentUsageProfileId = null;
    }

    this.debugLog('[UsageMonitor] Cleared usage cache for profile:', {
      profileId,
      wasInCache: deleted,
      clearedCurrentUsage
    });
  }

  /**
   * Clear a profile from the auth-failed list.
   * Called after successful re-authentication to allow the profile to be used again.
   *
   * @param profileId - Profile identifier to clear from failed list
   */
  clearAuthFailedProfile(profileId: string): void {
    const wasInFailedList = this.authFailedProfiles.has(profileId);
    const wasNeedsReauth = this.needsReauthProfiles.has(profileId);
    this.authFailedProfiles.delete(profileId);
    this.needsReauthProfiles.delete(profileId);
    this.clearProfileUsageCache(profileId);

    if (wasInFailedList || wasNeedsReauth) {
      this.debugLog('[UsageMonitor] Cleared auth failure status for profile: ' + profileId, {
        wasInFailedList,
        wasNeedsReauth
      });
    }
  }

  /**
   * Trigger an immediate usage check.
   * Called after re-authentication to give the user immediate feedback.
   */
  checkNow(): void {
    this.debugLog('[UsageMonitor] Immediate check triggered');
    this.checkUsageAndSwap().catch(error => {
      console.error('[UsageMonitor] Immediate check failed:', error);
    });
  }

  /**
   * Get all profiles usage data (for multi-profile display in UI)
   * Returns cached data if fresh, otherwise fetches for all profiles
   *
   * Uses parallel fetching for inactive profiles to minimize blocking delays.
   *
   * @param forceRefresh - If true, bypasses cache and fetches fresh data for all profiles
   */
  async getAllProfilesUsage(forceRefresh: boolean = false): Promise<AllProfilesUsage | null> {
    const profileManager = getClaudeProfileManager();
    const settings = profileManager.getSettings();
    const activeProfileId = settings.activeProfileId;

    // CRITICAL: On startup, currentUsage may be null, but we still need to check for
    // missing credentials to show the re-auth indicator. Proactively check all profiles
    // for missing credentials and populate needsReauthProfiles.
    if (!this.currentUsage) {
      // Fast path: no coalescing needed since this is synchronous-ish and returns quickly
      // Check all OAuth profiles for missing credentials
      for (const profile of settings.profiles) {
        if (profile.configDir) {
          const expandedConfigDir = profile.configDir.startsWith('~')
            ? profile.configDir.replace(/^~/, homedir())
            : profile.configDir;
          const creds = getCredentialsFromKeychain(expandedConfigDir);
          if (!creds.token) {
            // Credentials are missing - mark for re-auth
            this.needsReauthProfiles.add(profile.id);
            this.debugLog('[UsageMonitor:getAllProfilesUsage] Profile needs re-auth (no credentials): ' + profile.name);
          }
        }
      }

      // Build a minimal response with needsReauthentication flags even without usage data
      const allProfiles: ProfileUsageSummary[] = settings.profiles.map(profile => ({
        profileId: profile.id,
        profileName: profile.name,
        profileEmail: profile.email,
        sessionPercent: 0,
        weeklyPercent: 0,
        isAuthenticated: profile.isAuthenticated ?? false,
        isRateLimited: false,
        availabilityScore: profile.isAuthenticated ? 100 : 0,
        isActive: profile.id === activeProfileId,
        needsReauthentication: this.needsReauthProfiles.has(profile.id)
      }));

      // Include Codex (OpenAI OAuth) accounts from providerAccounts
      await this.appendCodexAccounts(allProfiles);
      // Include Z.AI provider accounts from providerAccounts
      await this.appendZAIAccounts(allProfiles);
      // Include OpenRouter provider accounts from providerAccounts
      await this.appendOpenRouterAccounts(allProfiles);

      // Return minimal data with auth status - don't return null!
      return {
        activeProfile: {
          profileId: activeProfileId || '',
          profileName: settings.profiles.find(p => p.id === activeProfileId)?.name || '',
          sessionPercent: 0,
          weeklyPercent: 0,
          fetchedAt: new Date(),
          needsReauthentication: this.needsReauthProfiles.has(activeProfileId || '')
        },
        allProfiles,
        fetchedAt: new Date()
      };
    }

    // Request coalescing: if a fetch is already in-flight, return the existing promise
    // This prevents burst API calls when multiple callers trigger getAllProfilesUsage() simultaneously
    if (!forceRefresh && this.allProfilesUsageInflight) {
      return this.allProfilesUsageInflight;
    }

    this.allProfilesUsageInflight = this._doGetAllProfilesUsage(forceRefresh);
    try {
      return await this.allProfilesUsageInflight;
    } finally {
      this.allProfilesUsageInflight = null;
    }
  }

  private async _doGetAllProfilesUsage(
    forceRefresh: boolean
  ): Promise<AllProfilesUsage | null> {
    const profileManager = getClaudeProfileManager();
    const settings = profileManager.getSettings();
    const activeProfileId = settings.activeProfileId;
    const now = Date.now();
    const allProfiles: ProfileUsageSummary[] = [];

    // First pass: identify profiles that need fresh data vs cached
    type ProfileToFetch = { profile: typeof settings.profiles[0]; index: number };
    const profilesToFetch: ProfileToFetch[] = [];
    const profileResults: (ProfileUsageSummary | null)[] = new Array(settings.profiles.length).fill(null);

    // Adaptive cache TTL: when active profile usage is high, refresh inactive profiles more
    // frequently (every 60s instead of 5min) because we may need to swap soon
    const activeUsageHigh = this.currentUsage
      ? (this.currentUsage.sessionPercent > 80 || this.currentUsage.weeklyPercent > 90)
      : false;
    const effectiveCacheTtl = activeUsageHigh
      ? 60 * 1000 // 60s when usage is high (swap-ready mode)
      : UsageMonitor.PROFILE_USAGE_CACHE_TTL_MS; // 5 min normally

    for (let i = 0; i < settings.profiles.length; i++) {
      const profile = settings.profiles[i];
      const cached = this.allProfilesUsageCache.get(profile.id);

      // Use cached data if fresh (within TTL) and not force refreshing
      if (!forceRefresh && cached && (now - cached.fetchedAt) < effectiveCacheTtl) {
        profileResults[i] = {
          ...cached.usage,
          isActive: profile.id === activeProfileId
        };
        continue;
      }

      // For active profile, use the current detailed usage (always fresh from last poll)
      if (profile.id === activeProfileId && this.currentUsage) {
        const summary = this.buildProfileUsageSummary(profile, this.currentUsage);
        profileResults[i] = summary;
        this.allProfilesUsageCache.set(profile.id, { usage: summary, fetchedAt: now });
        continue;
      }

      // Mark for parallel fetch
      profilesToFetch.push({ profile, index: i });
    }

    // Parallel fetch for all inactive profiles that need fresh data
    if (profilesToFetch.length > 0) {
      // Collect usage updates for batch save (avoids race condition with concurrent saves)
      const usageUpdates: Array<{ profileId: string; sessionPercent: number; weeklyPercent: number }> = [];

      // Build provider lookup map for staggered fetching
      // OAuth profiles (with configDir) are always 'anthropic'; API profiles use their stored provider
      const providerAccountsMap = new Map<string, string>(); // profileId -> provider
      try {
        const appSettings = await readSettingsFileAsync();
        if (appSettings) {
          const accounts = appSettings.providerAccounts ?? [];
          for (const account of accounts) {
            providerAccountsMap.set(account.id, account.provider);
            if (account.claudeProfileId) {
              providerAccountsMap.set(account.claudeProfileId, account.provider);
            }
          }
        }
      } catch {
        // Use default 'anthropic' for all profiles if settings can't be read
      }

      // DEDUPLICATION: Group profiles by configDir to avoid fetching the same underlying
      // account multiple times. Multiple ClaudeProfileManager entries can point to the same
      // configDir (same OAuth credentials = same API endpoint = same usage data).
      // Only fetch once per unique configDir, then share the result with all siblings.
      type FetchItem = { profile: typeof profilesToFetch[0]['profile']; index: number };
      const configDirGroups = new Map<string, FetchItem[]>(); // configDir -> all profiles sharing it
      const noConfigDirItems: FetchItem[] = []; // profiles without configDir (API key profiles)

      for (const item of profilesToFetch) {
        const configDir = item.profile.configDir;
        if (configDir) {
          const group = configDirGroups.get(configDir) ?? [];
          group.push(item);
          configDirGroups.set(configDir, group);
        } else {
          noConfigDirItems.push(item);
        }
      }

      // Build the deduplicated fetch list: one representative per configDir + all non-configDir items
      const deduplicatedFetchItems: FetchItem[] = [];
      const configDirRepresentatives = new Map<string, FetchItem>(); // configDir -> representative item
      for (const [configDir, group] of configDirGroups) {
        const representative = group[0]; // fetch for the first profile in the group
        deduplicatedFetchItems.push(representative);
        configDirRepresentatives.set(configDir, representative);
      }
      deduplicatedFetchItems.push(...noConfigDirItems);

      if (configDirGroups.size < profilesToFetch.length - noConfigDirItems.length) {
        this.debugLog('[UsageMonitor] Deduplicated profiles by configDir:', {
          original: profilesToFetch.length,
          deduplicated: deduplicatedFetchItems.length,
          savedFetches: profilesToFetch.length - deduplicatedFetchItems.length
        });
      }

      // Group deduplicated items by provider for staggered fetching
      const providerGroups = new Map<string, FetchItem[]>();
      for (const item of deduplicatedFetchItems) {
        const provider = providerAccountsMap.get(item.profile.id) ?? 'anthropic';
        const group = providerGroups.get(provider) ?? [];
        group.push(item);
        providerGroups.set(provider, group);
      }

      // 15-second stagger between consecutive same-provider fetches
      const STAGGER_DELAY_MS = 15_000;

      // Fetch provider groups in parallel; within each group, stagger sequentially
      type FetchResult = {
        index: number;
        update: { profileId: string; sessionPercent: number; weeklyPercent: number } | null;
        profile: FetchItem['profile'];
        inactiveUsage: ClaudeUsageSnapshot | null;
        rateLimitStatus: ReturnType<typeof isProfileRateLimited>;
        sessionPercent?: number;
        weeklyPercent?: number;
      };
      const groupPromises = Array.from(providerGroups.values()).map(async (group) => {
        const groupResults: FetchResult[] = [];

        for (let gi = 0; gi < group.length; gi++) {
          if (gi > 0) {
            await new Promise<void>(resolve => setTimeout(resolve, STAGGER_DELAY_MS));
          }
          const { profile, index } = group[gi];
          const inactiveUsage = await this.fetchUsageForInactiveProfile(profile);
          const rateLimitStatus = isProfileRateLimited(profile);

          if (inactiveUsage) {
            groupResults.push({
              index,
              update: { profileId: profile.id, sessionPercent: inactiveUsage.sessionPercent, weeklyPercent: inactiveUsage.weeklyPercent },
              profile,
              inactiveUsage,
              rateLimitStatus
            });
          } else {
            groupResults.push({
              index,
              update: null,
              profile,
              inactiveUsage,
              rateLimitStatus,
              sessionPercent: profile.usage?.sessionUsagePercent ?? 0,
              weeklyPercent: profile.usage?.weeklyUsagePercent ?? 0
            });
          }
        }
        return groupResults;
      });

      // Wait for all provider groups to complete in parallel
      const allGroupResults = await Promise.all(groupPromises);
      const fetchResults = allGroupResults.flat();

      // Build a map of configDir -> fetch result for sharing with sibling profiles
      const configDirFetchResults = new Map<string, FetchResult>();

      // Collect all updates and build summaries for fetched (representative) profiles
      for (const result of fetchResults) {
        const { index, update, profile, inactiveUsage, rateLimitStatus } = result;

        // Get percentages from either the update or the fallback values
        const sessionPercent = update?.sessionPercent ?? result.sessionPercent ?? 0;
        const weeklyPercent = update?.weeklyPercent ?? result.weeklyPercent ?? 0;

        if (update) {
          usageUpdates.push(update);
        }

        const summary: ProfileUsageSummary = {
          profileId: profile.id,
          profileName: profile.name,
          profileEmail: profile.email,
          sessionPercent,
          weeklyPercent,
          isAuthenticated: profile.isAuthenticated ?? false,
          isRateLimited: rateLimitStatus.limited,
          rateLimitType: rateLimitStatus.type,
          availabilityScore: this.calculateAvailabilityScore(
            sessionPercent,
            weeklyPercent,
            rateLimitStatus.limited,
            rateLimitStatus.type,
            profile.isAuthenticated ?? false
          ),
          isActive: profile.id === activeProfileId,
          lastFetchedAt: inactiveUsage?.fetchedAt?.toISOString() ?? profile.usage?.lastUpdated?.toISOString(),
          needsReauthentication: this.needsReauthProfiles.has(profile.id)
        };

        this.allProfilesUsageCache.set(profile.id, { usage: summary, fetchedAt: now });
        profileResults[index] = summary;

        // Store fetch result for sibling profiles sharing the same configDir
        if (profile.configDir) {
          configDirFetchResults.set(profile.configDir, result);
        }
      }

      // Propagate fetch results to sibling profiles that share the same configDir
      // (these were deduplicated above and not fetched individually)
      for (const [configDir, group] of configDirGroups) {
        if (group.length <= 1) continue; // No siblings to propagate to
        const representativeResult = configDirFetchResults.get(configDir);
        if (!representativeResult) continue;

        const { inactiveUsage } = representativeResult;
        const sessionPercent = representativeResult.update?.sessionPercent ?? representativeResult.sessionPercent ?? 0;
        const weeklyPercent = representativeResult.update?.weeklyPercent ?? representativeResult.weeklyPercent ?? 0;

        // Skip the first item (already processed as the representative)
        for (let si = 1; si < group.length; si++) {
          const sibling = group[si];
          const rateLimitStatus = isProfileRateLimited(sibling.profile);

          // Copy rate-limit/failure state from representative to sibling
          if (this.rateLimitedProfiles.has(representativeResult.profile.id)) {
            const ts = this.rateLimitedProfiles.get(representativeResult.profile.id)!;
            this.rateLimitedProfiles.set(sibling.profile.id, ts);
          }

          usageUpdates.push({ profileId: sibling.profile.id, sessionPercent, weeklyPercent });

          const summary: ProfileUsageSummary = {
            profileId: sibling.profile.id,
            profileName: sibling.profile.name,
            profileEmail: sibling.profile.email,
            sessionPercent,
            weeklyPercent,
            isAuthenticated: sibling.profile.isAuthenticated ?? false,
            isRateLimited: rateLimitStatus.limited,
            rateLimitType: rateLimitStatus.type,
            availabilityScore: this.calculateAvailabilityScore(
              sessionPercent,
              weeklyPercent,
              rateLimitStatus.limited,
              rateLimitStatus.type,
              sibling.profile.isAuthenticated ?? false
            ),
            isActive: sibling.profile.id === activeProfileId,
            lastFetchedAt: inactiveUsage?.fetchedAt?.toISOString() ?? sibling.profile.usage?.lastUpdated?.toISOString(),
            needsReauthentication: this.needsReauthProfiles.has(sibling.profile.id)
          };

          this.allProfilesUsageCache.set(sibling.profile.id, { usage: summary, fetchedAt: now });
          profileResults[sibling.index] = summary;
        }
      }

      // Batch save all usage updates at once (single disk write, no race condition)
      if (usageUpdates.length > 0) {
        profileManager.batchUpdateProfileUsageFromAPI(usageUpdates);
      }
    }

    // Collect non-null results
    for (const result of profileResults) {
      if (result) {
        allProfiles.push(result);
      }
    }

    // Include Codex (OpenAI OAuth) accounts from providerAccounts
    await this.appendCodexAccounts(allProfiles);
    // Include Z.AI provider accounts from providerAccounts
    await this.appendZAIAccounts(allProfiles);
    // Include OpenRouter provider accounts from providerAccounts
    await this.appendOpenRouterAccounts(allProfiles);

    // Sort by availability score (highest first = most available)
    allProfiles.sort((a, b) => b.availabilityScore - a.availabilityScore);

    return {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      activeProfile: this.currentUsage!, // Non-null: _doGetAllProfilesUsage is only called when currentUsage is set
      allProfiles,
      fetchedAt: new Date()
    };
  }

  /**
   * Fetch usage for an inactive profile using its own credentials
   * This allows showing real usage data for non-active profiles
   *
   * Uses ensureValidToken to proactively refresh tokens before making API calls,
   * preventing 401 errors for inactive profiles whose tokens may have expired.
   */
  private async fetchUsageForInactiveProfile(
    profile: { id: string; name: string; email?: string; configDir?: string; isAuthenticated?: boolean }
  ): Promise<ClaudeUsageSnapshot | null> {
    // Only fetch for authenticated profiles with a configDir
    if (!profile.isAuthenticated || !profile.configDir) {
      this.debugLog('[UsageMonitor] Skipping inactive profile fetch - not authenticated or no configDir:', {
        profileId: profile.id,
        profileName: profile.name,
        isAuthenticated: profile.isAuthenticated,
        hasConfigDir: !!profile.configDir
      });
      return null;
    }

    try {
      // Get credentials from keychain for this profile's configDir
      const expandedConfigDir = profile.configDir.startsWith('~')
        ? profile.configDir.replace(/^~/, homedir())
        : profile.configDir;

      const resolved = await resolveInactiveProfileToken(
        { needsReauthProfiles: this.needsReauthProfiles, log: this.credentialLog },
        profile,
        expandedConfigDir
      );
      if (!resolved) {
        return null;
      }
      const { token, wasRefreshed } = resolved;

      this.traceLog('[UsageMonitor] Fetching usage for inactive profile:', {
        profileId: profile.id,
        profileName: profile.name,
        tokenFingerprint: getCredentialFingerprint(token),
        wasRefreshed
      });

      // Fetch usage via API - OAuth profiles always use Anthropic
      const usage = await this.fetchUsageViaAPI(
        token,
        profile.id,
        profile.name,
        profile.email,
        {
          profileId: profile.id,
          profileName: profile.name,
          profileEmail: profile.email,
          isAPIProfile: false,
          baseUrl: 'https://api.anthropic.com'
        }
      );

      if (usage) {
        this.traceLog('[UsageMonitor] Successfully fetched inactive profile usage:', {
          profileName: profile.name,
          sessionPercent: usage.sessionPercent,
          weeklyPercent: usage.weeklyPercent
        });
      }

      return usage;
    } catch (error) {
      this.debugLog('[UsageMonitor] Failed to fetch inactive profile usage: ' + profile.name, error);
      return null;
    }
  }

  /**
   * Build a ProfileUsageSummary from a ClaudeUsageSnapshot
   */
  private buildProfileUsageSummary(
    profile: { id: string; name: string; email?: string; isAuthenticated?: boolean },
    usage: ClaudeUsageSnapshot
  ): ProfileUsageSummary {
    const profileManager = getClaudeProfileManager();
    const fullProfile = profileManager.getProfile(profile.id);
    const rateLimitStatus = fullProfile ? isProfileRateLimited(fullProfile) : { limited: false };

    return {
      profileId: profile.id,
      profileName: profile.name,
      profileEmail: usage.profileEmail || profile.email,
      sessionPercent: usage.sessionPercent,
      weeklyPercent: usage.weeklyPercent,
      sessionResetTimestamp: usage.sessionResetTimestamp,
      weeklyResetTimestamp: usage.weeklyResetTimestamp,
      isAuthenticated: profile.isAuthenticated ?? true,
      isRateLimited: rateLimitStatus.limited,
      rateLimitType: rateLimitStatus.type,
      availabilityScore: this.calculateAvailabilityScore(
        usage.sessionPercent,
        usage.weeklyPercent,
        rateLimitStatus.limited,
        rateLimitStatus.type,
        profile.isAuthenticated ?? true
      ),
      isActive: usage.profileId === profileManager.getActiveProfile()?.id,
      lastFetchedAt: usage.fetchedAt?.toISOString(),
      needsReauthentication: this.needsReauthProfiles.has(profile.id)
    };
  }

  /**
   * Calculate availability score for a profile (higher = more available)
   *
   * Scoring algorithm:
   * - Base score: 100
   * - Rate limited: -500 (session) or -1000 (weekly)
   * - Unauthenticated: -500
   * - Weekly usage penalty: -(weeklyPercent * 0.5)
   * - Session usage penalty: -(sessionPercent * 0.2)
   */
  private calculateAvailabilityScore(
    sessionPercent: number,
    weeklyPercent: number,
    isRateLimited: boolean,
    rateLimitType?: 'session' | 'weekly',
    isAuthenticated: boolean = true
  ): number {
    return calculateAvailabilityScore(sessionPercent, weeklyPercent, isRateLimited, rateLimitType, isAuthenticated);
  }

  /**
   * Append Codex (OpenAI OAuth) provider accounts to the allProfiles list.
   * These accounts live in providerAccounts (settings.json), not in ClaudeProfileManager,
   * so they must be added separately.
   */
  private async appendCodexAccounts(allProfiles: ProfileUsageSummary[]): Promise<void> {
    await appendProviderAccountUsage(allProfiles, codexUsageSource, {
      currentUsage: this.currentUsage,
      log: (message, data) => this.debugLog(message, data),
    });
  }

  /**
   * Append Z.AI provider accounts to the allProfiles list.
   * Z.AI accounts use API keys and have a quota/limit monitoring API.
   */
  private async appendZAIAccounts(allProfiles: ProfileUsageSummary[]): Promise<void> {
    await appendProviderAccountUsage(allProfiles, zaiUsageSource, {
      currentUsage: this.currentUsage,
      log: (message, data) => this.debugLog(message, data),
    });
  }

  /**
   * Append OpenRouter provider accounts to the allProfiles list.
   * OpenRouter accounts use API keys; usage comes from GET /api/v1/key.
   */
  private async appendOpenRouterAccounts(allProfiles: ProfileUsageSummary[]): Promise<void> {
    await appendProviderAccountUsage(allProfiles, openrouterUsageSource, {
      currentUsage: this.currentUsage,
      log: (message, data) => this.debugLog(message, data),
    });
  }

  /**
   * Get credential for usage monitoring (OAuth token or API key)
   * Detects profile type and returns appropriate credential
   *
   * Priority:
   * 1. API Profile (if active) - returns apiKey directly
   * 2. OAuth Profile - reads FRESH token from Keychain (not cached oauthToken)
   *
   * IMPORTANT: For OAuth profiles, we read from Keychain instead of cached profile.oauthToken.
   * OAuth tokens expire in 8-12 hours, but Claude CLI auto-refreshes and stores fresh tokens
   * in Keychain. Using cached tokens causes 401 errors after a few hours.
   * See: docs/LONG_LIVED_AUTH_PLAN.md
   *
   * @returns The credential string or undefined if none available
   */
  private async getCredential(): Promise<string | undefined> {
    return resolveActiveCredential({
      needsReauthProfiles: this.needsReauthProfiles,
      log: this.credentialLog
    });
  }

  /**
   * Check usage and trigger swap if thresholds exceeded
   *
   * Refactored to use helper methods for better maintainability:
   * - determineActiveProfile(): Detects API vs OAuth profile
   * - checkThresholdsExceeded(): Evaluates usage against thresholds
   * - handleAuthFailure(): Manages auth failure recovery
   */
  private async checkUsageAndSwap(): Promise<void> {
    if (this.isChecking) {
      return; // Prevent concurrent checks
    }

    this.isChecking = true;
    let profileId: string | undefined;
    let isAPIProfile = false;

    try {
      // Step 1: Determine active profile (API vs OAuth)
      const activeProfile = await this.determineActiveProfile();
      if (!activeProfile) {
        return; // No active profile
      }

      profileId = activeProfile.profileId;
      isAPIProfile = activeProfile.isAPIProfile;

      // Step 2: Fetch current usage using the credential resolved by determineActiveProfile
      const usage = await this.fetchUsage(profileId, activeProfile.credential, activeProfile);
      if (!usage) {
        this.traceLog('[UsageMonitor] Failed to fetch usage (API may be rate-limited or credential unavailable)');
        return;
      }

      // Add needsReauthentication flag to the snapshot for the active profile
      // A successful API-key fetch means the key works again; clear any stale auth flag
      if (isAPIProfile) {
        this.needsReauthProfiles.delete(profileId);
      }
      usage.needsReauthentication = this.needsReauthProfiles.has(profileId);

      this.currentUsage = usage;
      this.currentUsageProfileId = profileId; // Track which profile this usage belongs to

      // Step 2.5: Persist usage to profile for caching (so other profiles can display cached usage)
      const profileManager = getClaudeProfileManager();
      profileManager.updateProfileUsageFromAPI(profileId, usage.sessionPercent, usage.weeklyPercent);

      // Step 3: Emit usage update for UI (always emit, regardless of proactive swap settings)
      this.emit('usage-updated', usage);

      // Step 3.5: Emit all profiles usage for multi-profile display
      const allProfilesUsage = await this.getAllProfilesUsage();
      if (allProfilesUsage) {
        this.emit('all-profiles-usage-updated', allProfilesUsage);

        // Single summary line for debug output
        if (this.isDebug) {
          const summary = allProfilesUsage.allProfiles
            .map(p => `${p.profileName} ${p.sessionPercent}%/${p.weeklyPercent}%`)
            .join(' | ');
          console.warn(`[UsageMonitor] Usage: ${summary}`);
        }
      }

      // Step 4: Check thresholds and perform proactive swap (OAuth profiles only)
      if (!isAPIProfile) {
        const profileManager = getClaudeProfileManager();
        const settings = profileManager.getAutoSwitchSettings();

        if (!settings.enabled || !settings.proactiveSwapEnabled) {
          this.traceLog('[UsageMonitor:TRACE] Proactive swap disabled, skipping threshold check');
          return;
        }

        const thresholds = this.checkThresholdsExceeded(usage, settings);

        if (thresholds.anyExceeded) {
          this.traceLog('[UsageMonitor:TRACE] Threshold exceeded', {
            sessionPercent: usage.sessionPercent,
            weekPercent: usage.weeklyPercent,
            activeProfile: profileId,
            hasCredential: !!activeProfile.credential
          });

          this.debugLog('[UsageMonitor] Threshold exceeded:', {
            sessionPercent: usage.sessionPercent,
            sessionThreshold: settings.sessionThreshold ?? 95,
            weeklyPercent: usage.weeklyPercent,
            weeklyThreshold: settings.weeklyThreshold ?? 99
          });

          // Attempt proactive swap
          await this.performProactiveSwap(
            profileId,
            thresholds.sessionExceeded ? 'session' : 'weekly'
          );
        } else {
          this.traceLog('[UsageMonitor:TRACE] Usage OK', {
            sessionPercent: usage.sessionPercent,
            weekPercent: usage.weeklyPercent
          });
        }
      } else {
        this.traceLog('[UsageMonitor:TRACE] Skipping proactive swap for API profile (only supported for OAuth profiles)');
      }
    } catch (error) {
      // Step 5: Handle auth failures
      if (isHttpError(error) && (error.statusCode === 401 || error.statusCode === 403)) {
        if (profileId) {
          await this.handleAuthFailure(profileId, isAPIProfile);
          return; // handleAuthFailure manages its own logging
        }
      }

      console.error('[UsageMonitor] Check failed:', error);
    } finally {
      this.isChecking = false;
    }
  }

  /**
   * Check if API method should be used for a specific profile
   *
   * Uses cooldown-based retry: API is retried after API_FAILURE_COOLDOWN_MS
   *
   * @param profileId - Profile identifier
   * @returns true if API should be tried, false if CLI should be used
   */
  private shouldUseApiMethod(profileId: string): boolean {
    // Check rate-limit (429) cooldown first — longer backoff than general API failures
    // Also check sibling profiles that share the same configDir (same underlying API endpoint).
    // When Anthropic 429s one profile, all profiles sharing the same credential are also blocked.
    const profileIdsToCheck = this.getProfileIdFamily(profileId);

    for (const id of profileIdsToCheck) {
      const lastRateLimit = this.rateLimitedProfiles.get(id);
      if (lastRateLimit) {
        const elapsed = Date.now() - lastRateLimit;
        if (elapsed < UsageMonitor.RATE_LIMIT_COOLDOWN_MS) {
          return false; // Any sibling is rate-limited → block all
        }
        this.rateLimitedProfiles.delete(id); // Cooldown expired, clear the marker
      }
    }

    // Check general API failure cooldown
    const lastFailure = this.apiFailureTimestamps.get(profileId);
    if (!lastFailure) return true; // No previous failure, try API
    // Check if cooldown has expired (use >= to allow retry at exact boundary)
    const elapsed = Date.now() - lastFailure;
    return elapsed >= UsageMonitor.API_FAILURE_COOLDOWN_MS;
  }

  /**
   * Get all profile IDs that share the same configDir as the given profile.
   * This is used to propagate rate-limit state across duplicate profile entries
   * that point to the same underlying OAuth credential/API endpoint.
   */
  private getProfileIdFamily(profileId: string): string[] {
    try {
      const profileManager = getClaudeProfileManager();
      const settings = profileManager.getSettings();
      const targetProfile = settings.profiles.find(p => p.id === profileId);

      if (!targetProfile?.configDir) return [profileId];

      // Find all profiles with the same configDir
      const siblings = settings.profiles
        .filter(p => p.configDir === targetProfile.configDir)
        .map(p => p.id);

      return siblings.length > 0 ? siblings : [profileId];
    } catch {
      return [profileId];
    }
  }

  /**
   * Determine which profile is active by reading globalPriorityOrder from settings.
   * The first account in the priority order is considered the active one — this
   * matches the UI's account-selection logic so usage monitoring always tracks the
   * same account the user sees as "active".
   *
   * Supported account types (in order of detection within the priority list):
   *   - Anthropic OAuth  (provider: 'anthropic', authType: 'oauth')
   *   - Anthropic API key (provider: 'anthropic', authType: 'api-key')
   *   - OpenAI/Codex OAuth (provider: 'openai', authType: 'oauth')
   *   - Z.AI API key (provider: 'zai')
   *   - OpenRouter API key (provider: 'openrouter')
   *   - Other providers: returns null (no usage monitoring supported)
   *
   * @returns Active profile info (including resolved credential) or null if undetermined
   */
  private async determineActiveProfile(): Promise<ActiveProfileResult | null> {
    return resolveActiveProfile({
      needsReauthProfiles: this.needsReauthProfiles,
      log: this.credentialLog
    });
  }

  /**
   * Legacy fallback for determineActiveProfile when settings/globalPriorityOrder
   * are not available. Uses the old hardcoded priority:
   *   1. API profiles file (loadProfilesFile)
   *   2. ClaudeProfileManager.getActiveProfile()
   *
   * @returns Active profile info or null
   */
  private async determineActiveProfileLegacy(): Promise<ActiveProfileResult | null> {
    return resolveActiveProfileLegacy({
      needsReauthProfiles: this.needsReauthProfiles,
      log: this.credentialLog
    });
  }

  /**
   * Check if thresholds are exceeded for proactive swapping
   *
   * @param usage - Current usage snapshot
   * @param settings - Auto-switch settings
   * @returns Object indicating which thresholds are exceeded
   */
  private checkThresholdsExceeded(
    usage: ClaudeUsageSnapshot,
    settings: { sessionThreshold?: number; weeklyThreshold?: number }
  ): { sessionExceeded: boolean; weeklyExceeded: boolean; anyExceeded: boolean } {
    const sessionExceeded = usage.sessionPercent >= (settings.sessionThreshold ?? 95);
    const weeklyExceeded = usage.weeklyPercent >= (settings.weeklyThreshold ?? 99);

    return {
      sessionExceeded,
      weeklyExceeded,
      anyExceeded: sessionExceeded || weeklyExceeded
    };
  }

  /**
   * Handle auth failure by attempting token refresh, then marking profile as failed
   * and attempting proactive swap if refresh fails.
   *
   * @param profileId - Profile that failed auth
   * @param isAPIProfile - Whether this is an API profile (token refresh only for OAuth)
   */
  private async handleAuthFailure(profileId: string, isAPIProfile: boolean): Promise<void> {
    const profileManager = getClaudeProfileManager();

    // For OAuth profiles, attempt token refresh before giving up
    if (!isAPIProfile) {
      const profile = profileManager.getProfile(profileId);
      if (profile?.configDir) {
        this.debugLog('[UsageMonitor] Auth failure - attempting token refresh for profile: ' + profileId);

        try {
          const refreshResult = await reactiveTokenRefresh(profile.configDir);

          if (refreshResult.wasRefreshed && refreshResult.token) {
            this.debugLog('[UsageMonitor] Token refresh successful for profile: ' + profileId, {
              tokenFingerprint: getCredentialFingerprint(refreshResult.token)
            });

            // Check if token refresh succeeded but persistence failed
            // The token works for this session but will be lost on restart
            if (refreshResult.persistenceFailed) {
              console.warn('[UsageMonitor] Token refreshed but persistence failed for profile: ' + profileId +
                ' - user should re-authenticate to avoid auth errors on next restart');
              this.needsReauthProfiles.add(profileId);
            } else {
              // Token was refreshed and persisted successfully - clear from needsReauth if present
              this.needsReauthProfiles.delete(profileId);
            }

            // Token was refreshed - don't mark as failed, let next poll use the new token
            return;
          }

          if (refreshResult.error) {
            this.debugLog('[UsageMonitor] Token refresh failed:', refreshResult.error);

            // Check for invalid_grant error - indicates refresh token is permanently invalid
            // and user needs to manually re-authenticate (matches inactive profile handling)
            if (refreshResult.errorCode === 'invalid_grant') {
              this.debugLog('[UsageMonitor] Profile needs re-authentication (invalid refresh token): ' + profileId);
              this.needsReauthProfiles.add(profileId);
            }
          }
        } catch (refreshError) {
          console.error('[UsageMonitor] Token refresh threw error:', refreshError);
        }

        // Refresh failed - clear cache so next attempt gets fresh credentials
        this.debugLog('[UsageMonitor] Auth failure - clearing keychain cache for profile: ' + profileId);
        clearKeychainCache(profile.configDir);
      }
    }

    // API-key profiles have no refresh path; surface the pending-auth indicator
    if (isAPIProfile) {
      this.needsReauthProfiles.add(profileId);
    }

    // Mark this profile as auth-failed to prevent swap loops
    // This MUST happen before the early return to prevent infinite loops
    this.authFailedProfiles.set(profileId, Date.now());
    this.debugLog('[UsageMonitor] Auth failure detected, marked profile as failed: ' + profileId);

    // Clean up expired entries from the failed profiles map
    const now = Date.now();
    this.authFailedProfiles.forEach((timestamp, failedProfileId) => {
      if (now - timestamp > UsageMonitor.AUTH_FAILURE_COOLDOWN_MS) {
        this.authFailedProfiles.delete(failedProfileId);
      }
    });

    const settings = profileManager.getAutoSwitchSettings();

    // Proactive swap is only supported for OAuth profiles, not API profiles
    if (isAPIProfile || !settings.enabled || !settings.proactiveSwapEnabled) {
      this.debugLog('[UsageMonitor] Auth failure detected but proactive swap is disabled or using API profile, skipping swap');
      return;
    }

    try {
      const excludeProfiles = Array.from(this.authFailedProfiles.keys());
      this.debugLog('[UsageMonitor] Attempting proactive swap (excluding failed profiles):', excludeProfiles);
      await this.performProactiveSwap(
        profileId,
        'session', // Treat auth failure as session limit for immediate swap
        excludeProfiles
      );
    } catch (swapError) {
      console.error('[UsageMonitor] Failed to perform auth-failure swap:', swapError);
    }
  }

  /**
   * Fetch usage - HYBRID APPROACH
   * Tries API first, falls back to CLI if API fails
   *
   * Enhanced to support multiple providers (Anthropic, z.ai, ZHIPU)
   * Detects provider from active profile's baseUrl and routes to appropriate endpoint
   *
   * @param profileId - Profile identifier
   * @param credential - OAuth token or API key
   * @param activeProfile - Optional active profile info to avoid race conditions
   */
  private async fetchUsage(
    profileId: string,
    credential?: string,
    activeProfile?: ActiveProfileResult
  ): Promise<ClaudeUsageSnapshot | null> {
    // Get profile name and email - prefer activeProfile since it's already determined
    let profileName: string | undefined;
    let profileEmail: string | undefined;

    // Use activeProfile data if available (already fetched and validated)
    // This fixes the bug where API profile names were incorrectly shown for OAuth profiles
    if (activeProfile?.profileName) {
      profileName = activeProfile.profileName;
      profileEmail = activeProfile.profileEmail;
      this.traceLog('[UsageMonitor:FETCH] Using activeProfile data:', {
        profileId,
        profileName,
        profileEmail,
        isAPIProfile: activeProfile.isAPIProfile
      });
    }

    // Only search API profiles if not already set from activeProfile
    if (!profileName) {
      try {
        const profilesFile = await loadProfilesFile();
        const apiProfile = profilesFile.profiles.find(p => p.id === profileId);
        if (apiProfile) {
          profileName = apiProfile.name;
          this.traceLog('[UsageMonitor:FETCH] Found API profile:', {
            profileId,
            profileName,
            baseUrl: apiProfile.baseUrl
          });
        }
      } catch (error) {
        // Failed to load API profiles, continue to OAuth check
        this.traceLog('[UsageMonitor:FETCH] Failed to load API profiles:', error);
      }
    }

    // If not found in API profiles, check OAuth profiles
    if (!profileName) {
      const profileManager = getClaudeProfileManager();
      const oauthProfile = profileManager.getProfile(profileId);
      if (oauthProfile) {
        profileName = oauthProfile.name;
        // Get email from OAuth profile if not already set
        if (!profileEmail) {
          profileEmail = oauthProfile.email;
        }
        this.traceLog('[UsageMonitor:FETCH] Found OAuth profile:', {
          profileId,
          profileName,
          profileEmail
        });
      }
    }

    // If still not found, return null
    if (!profileName) {
      this.traceLog('[UsageMonitor:FETCH] Profile not found in either API or OAuth profiles: ' + profileId);
      return null;
    }

    this.traceLog('[UsageMonitor:FETCH] Starting usage fetch:', {
      profileId,
      profileName,
      hasCredential: !!credential,
      useApiMethod: this.shouldUseApiMethod(profileId)
    });

    // Attempt 1: Direct API call (preferred)
    // Per-profile tracking: if API fails for one profile, it only affects that profile
    if (this.shouldUseApiMethod(profileId) && credential) {
      this.traceLog('[UsageMonitor:FETCH] Attempting API fetch method');
      const apiUsage = await this.fetchUsageViaAPI(credential, profileId, profileName, profileEmail, activeProfile);
      if (apiUsage) {
        this.traceLog('[UsageMonitor] Successfully fetched via API');
        this.traceLog('[UsageMonitor:FETCH] API fetch successful:', {
          sessionPercent: apiUsage.sessionPercent,
          weeklyPercent: apiUsage.weeklyPercent
        });
        return apiUsage;
      }

      // API failed - record timestamp for cooldown-based retry
      this.traceLog('[UsageMonitor:FETCH] API fetch failed, will retry after cooldown');
      this.apiFailureTimestamps.set(profileId, Date.now());
    } else if (!credential) {
      this.traceLog('[UsageMonitor:FETCH] No credential available, skipping API method');
    }

    // Attempt 2: CLI /usage command (fallback)
    this.traceLog('[UsageMonitor:FETCH] Attempting CLI fallback method');
    return await this.fetchUsageViaCLI(profileId, profileName);
  }

  /**
   * Fetch usage via provider-specific API endpoints
   *
   * Supports multiple providers with automatic detection:
   * - Anthropic OAuth: https://api.anthropic.com/api/oauth/usage
   * - z.ai: https://api.z.ai/api/monitor/usage/model-usage
   * - ZHIPU: https://open.bigmodel.cn/api/monitor/usage/model-usage
   *
   * Detects provider from active profile's baseUrl and routes to appropriate endpoint.
   * Normalizes all provider responses to common ClaudeUsageSnapshot format.
   *
   * @param credential - OAuth token or API key
   * @param profileId - Profile identifier
   * @param profileName - Profile display name
   * @param profileEmail - Optional email associated with the profile
   * @param activeProfile - Optional pre-determined active profile info to avoid race conditions
   * @returns Normalized usage snapshot or null on failure
   */
  private async fetchUsageViaAPI(
    credential: string,
    profileId: string,
    profileName: string,
    profileEmail?: string,
    activeProfile?: ActiveProfileResult
  ): Promise<ClaudeUsageSnapshot | null> {
    this.traceLog('[UsageMonitor:API_FETCH] Starting API fetch for usage:', {
      profileId,
      profileName,
      hasCredential: !!credential,
      hasActiveProfile: !!activeProfile
    });

    try {
      // Step 1: Determine if we're using an API profile or OAuth profile
      // Use passed activeProfile if available, otherwise detect to maintain backward compatibility
      let apiProfile: APIProfile | undefined;
      let baseUrl: string;
      let provider: ApiProvider;

      if (activeProfile?.isAPIProfile) {
        // Use the pre-determined profile to avoid race conditions
        // Trust the activeProfile data and use baseUrl directly
        baseUrl = activeProfile.baseUrl;
        provider = detectProvider(baseUrl);
      } else if (activeProfile && !activeProfile.isAPIProfile) {
        // OAuth profile — detect provider from baseUrl (supports Anthropic + Codex)
        baseUrl = activeProfile.baseUrl;
        provider = detectProvider(baseUrl);
      } else {
        // No activeProfile passed - need to detect from profiles file
        const profilesFile = await loadProfilesFile();
        apiProfile = profilesFile.profiles.find(p => p.id === profileId);

        if (apiProfile?.apiKey) {
          // API profile found
          baseUrl = apiProfile.baseUrl;
          provider = detectProvider(baseUrl);
        } else {
          // OAuth profile fallback
          provider = 'anthropic';
          baseUrl = 'https://api.anthropic.com';
        }
      }

      const isAPIProfile = !!apiProfile;
      this.traceLog('[UsageMonitor:TRACE] Fetching usage', {
        provider,
        baseUrl,
        isAPIProfile,
        profileId
      });

      const outcome = await fetchProviderUsage({
        credential,
        provider,
        baseUrl,
        profileId,
        profileName,
        profileEmail,
        log: this.logger
      });

      switch (outcome.kind) {
        case 'ok':
          return outcome.usage;
        case 'rate-limited': {
          // Handle rate limiting with a much longer backoff than general API failures
          // Propagate to all sibling profiles sharing the same configDir (same API endpoint)
          const now = Date.now();
          const siblingIds = this.getProfileIdFamily(profileId);
          console.warn('[UsageMonitor] Rate limited (429) by provider, backing off for 10 minutes:', {
            provider,
            endpoint: getUsageEndpoint(provider, baseUrl),
            cooldownMs: UsageMonitor.RATE_LIMIT_COOLDOWN_MS,
            affectedProfiles: siblingIds.length
          });
          for (const id of siblingIds) {
            this.rateLimitedProfiles.set(id, now);
          }
          return null;
        }
        case 'failed':
          if (outcome.cooldown) {
            // Record failure timestamp for cooldown retry
            this.apiFailureTimestamps.set(profileId, Date.now());
          }
          return null;
        default:
          return null;
      }
    } catch (error: any) {
      // Re-throw auth failures to be handled by checkUsageAndSwap
      // This includes both status code auth failures (401/403) and body-detected failures
      if (error?.message?.includes('Auth Failure') || error?.statusCode === 401 || error?.statusCode === 403) {
        throw error;
      }

      console.error('[UsageMonitor] API fetch failed:', error);
      // Record failure timestamp for cooldown retry (network/other errors)
      this.apiFailureTimestamps.set(profileId, Date.now());
      return null;
    }
  }

  /** Delegates to the Anthropic adapter normalizer */
  private normalizeAnthropicResponse(
    data: any,
    profileId: string,
    profileName: string,
    profileEmail?: string
  ): ClaudeUsageSnapshot {
    return normalizeAnthropicResponse(data, profileId, profileName, profileEmail);
  }

  /** Delegates to the shared quota/limit normalizer (z.ai and ZHIPU) */
  private normalizeQuotaLimitResponse(
    data: any,
    profileId: string,
    profileName: string,
    profileEmail: string | undefined,
    providerName: 'zai' | 'zhipu'
  ): ClaudeUsageSnapshot | null {
    return normalizeQuotaLimitResponse(data, profileId, profileName, profileEmail, providerName, this.isVerbose);
  }

  /** Normalize z.ai API response to ClaudeUsageSnapshot */
  private normalizeZAIResponse(
    data: any,
    profileId: string,
    profileName: string,
    profileEmail?: string
  ): ClaudeUsageSnapshot | null {
    return this.normalizeQuotaLimitResponse(data, profileId, profileName, profileEmail, 'zai');
  }

  /** Normalize ZHIPU AI response to ClaudeUsageSnapshot */
  private normalizeZhipuResponse(
    data: any,
    profileId: string,
    profileName: string,
    profileEmail?: string
  ): ClaudeUsageSnapshot | null {
    return this.normalizeQuotaLimitResponse(data, profileId, profileName, profileEmail, 'zhipu');
  }

  /**
   * Fetch usage via CLI /usage command (fallback)
   * Note: This is a fallback method. The API method is preferred.
   * CLI-based fetching would require spawning a Claude process and parsing output,
   * which is complex. For now, we rely on the API method.
   */
  private async fetchUsageViaCLI(
    _profileId: string,
    _profileName: string
  ): Promise<ClaudeUsageSnapshot | null> {
    // CLI-based usage fetching is not implemented yet.
    // The API method should handle most cases. If we need CLI fallback,
    // we would need to spawn a Claude process with /usage command and parse the output.
    // CLI-based usage fetching is intentionally not implemented.
    // The API method handles all cases; this fallback path is expected when API is rate-limited or unavailable.
    return null;
  }

  /**
   * Perform proactive profile swap
   * @param currentProfileId - The profile to switch from
   * @param limitType - The type of limit that triggered the swap
   * @param additionalExclusions - Additional profile IDs to exclude (e.g., auth-failed profiles)
   */
  private async performProactiveSwap(
    currentProfileId: string,
    limitType: 'session' | 'weekly',
    additionalExclusions: string[] = []
  ): Promise<void> {
    const profileManager = getClaudeProfileManager();
    const excludeIds = new Set([currentProfileId, ...additionalExclusions]);

    // Get priority order for unified account system
    const priorityOrder = profileManager.getAccountPriorityOrder();

    // Build unified list of available accounts
    type UnifiedSwapTarget = {
      id: string;
      unifiedId: string;  // oauth-{id} or api-{id}
      name: string;
      type: 'oauth' | 'api';
      priorityIndex: number;
      tier: 0 | 1;  // 1 = API key not yet verified, tried after everything else
    };

    const unifiedAccounts: UnifiedSwapTarget[] = [];

    // Add OAuth profiles (sorted by availability)
    const oauthProfiles = profileManager.getProfilesSortedByAvailability();
    for (const profile of oauthProfiles) {
      if (!excludeIds.has(profile.id)) {
        const unifiedId = `oauth-${profile.id}`;
        const priorityIndex = priorityOrder.indexOf(unifiedId);
        unifiedAccounts.push({
          id: profile.id,
          unifiedId,
          name: profile.name,
          type: 'oauth',
          priorityIndex: priorityIndex === -1 ? Infinity : priorityIndex,
          tier: 0
        });
      }
    }

    // Add API profiles (always considered available since they have unlimited usage)
    try {
      const profilesFile = await loadProfilesFile();
      for (const apiProfile of profilesFile.profiles) {
        if (!excludeIds.has(apiProfile.id) && apiProfile.apiKey && getKeyStatus(apiProfile) !== 'rejected') {
          const unifiedId = `api-${apiProfile.id}`;
          const priorityIndex = priorityOrder.indexOf(unifiedId);
          unifiedAccounts.push({
            id: apiProfile.id,
            unifiedId,
            name: apiProfile.name,
            type: 'api',
            priorityIndex: priorityIndex === -1 ? Infinity : priorityIndex,
            tier: failoverTier(getKeyStatus(apiProfile))
          });
        }
      }
    } catch (error) {
      this.debugLog('[UsageMonitor] Failed to load API profiles for swap:', error);
    }

    if (unifiedAccounts.length === 0) {
      this.debugLog('[UsageMonitor] No alternative profile for proactive swap (excluded:', Array.from(excludeIds));
      this.emit('proactive-swap-failed', {
        reason: additionalExclusions.length > 0 ? 'all_alternatives_failed_auth' : 'no_alternative',
        currentProfile: currentProfileId,
        excludedProfiles: Array.from(excludeIds)
      });
      return;
    }

    // Sort by priority order (lower index = higher priority)
    // If no priority order is set, OAuth profiles come first (they were already sorted by availability)
    unifiedAccounts.sort((a, b) => {
      // Verified/non-API accounts before unverified API keys
      if (a.tier !== b.tier) return a.tier - b.tier;
      // If both have priority indices, use them
      if (a.priorityIndex !== Infinity || b.priorityIndex !== Infinity) {
        return a.priorityIndex - b.priorityIndex;
      }
      // Otherwise, prefer OAuth profiles (which are sorted by availability)
      if (a.type !== b.type) {
        return a.type === 'oauth' ? -1 : 1;
      }
      return 0;
    });

    // Use the best available from unified accounts
    const bestAccount = unifiedAccounts[0];

    this.debugLog('[UsageMonitor] Proactive swap:', {
      from: currentProfileId,
      to: bestAccount.id,
      toType: bestAccount.type,
      reason: limitType
    });

    // Clear cache for the profile that's becoming inactive
    // This ensures the next fetch gets fresh data instead of stale cached values
    this.clearProfileUsageCache(currentProfileId);

    // Switch to the new profile
    // Note: bestAccount.id is already the raw profile ID (not unified format)
    const rawProfileId = bestAccount.id;

    if (bestAccount.type === 'oauth') {
      // Switch OAuth profile via profile manager
      profileManager.setActiveProfile(rawProfileId);
    } else {
      // Switch API profile via api-profile-store service
      try {
        const { setActiveAPIProfile } = await import('../services/profile/api-profile-store');
        await setActiveAPIProfile(rawProfileId);
      } catch (error) {
        console.error('[UsageMonitor] Failed to set active API profile:', error);
        return;
      }
    }

    // Get the "from" profile name
    let fromProfileName: string | undefined;
    const fromOAuthProfile = profileManager.getProfile(currentProfileId);
    if (fromOAuthProfile) {
      fromProfileName = fromOAuthProfile.name;
    } else {
      // It might be an API profile
      try {
        const profilesFile = await loadProfilesFile();
        const fromAPIProfile = profilesFile.profiles.find(p => p.id === currentProfileId);
        if (fromAPIProfile) {
          fromProfileName = fromAPIProfile.name;
        }
      } catch {
        // Ignore
      }
    }

    // Emit swap event
    this.emit('proactive-swap-completed', {
      fromProfile: { id: currentProfileId, name: fromProfileName },
      toProfile: { id: bestAccount.id, name: bestAccount.name },
      limitType,
      timestamp: new Date()
    });

    // Notify UI
    this.emit('show-swap-notification', {
      fromProfile: fromProfileName,
      toProfile: bestAccount.name,
      reason: 'proactive',
      limitType
    });

    // PROACTIVE OPERATION RESTART: Stop and restart all running Claude SDK operations with new profile credentials
    // This includes autonomous tasks, PR reviews, insights, roadmap, etc.
    // Claude Agent SDK sessions maintain state independently of auth tokens, so no progress is lost
    const operationRegistry = getOperationRegistry();
    const operationSummary = operationRegistry.getSummary();
    const operationIdsOnOldProfile = operationSummary.byProfile[currentProfileId] || [];

    // Always log running operations info for debugging
    appLog.info('[UsageMonitor] PROACTIVE-SWAP: Checking running operations:', {
      oldProfileId: currentProfileId,
      newProfileId: bestAccount.id,
      totalRunning: operationSummary.totalRunning,
      byProfile: operationSummary.byProfile,
      byType: operationSummary.byType,
      operationIdsOnOldProfile: operationIdsOnOldProfile
    });

    if (operationIdsOnOldProfile.length > 0) {
      appLog.info('[UsageMonitor] PROACTIVE-SWAP: Found', operationIdsOnOldProfile.length, 'operations to restart:', operationIdsOnOldProfile);

      // Restart all operations on the old profile with the new profile
      const restartedCount = await operationRegistry.restartOperationsOnProfile(
        currentProfileId,
        bestAccount.id,
        bestAccount.name
      );

      // Emit event for tracking/logging
      this.emit('proactive-operations-restarted', {
        fromProfile: { id: currentProfileId, name: fromProfileName },
        toProfile: { id: bestAccount.id, name: bestAccount.name },
        operationIds: operationIdsOnOldProfile,
        restartedCount,
        limitType,
        timestamp: new Date()
      });
    } else {
      appLog.info('[UsageMonitor] PROACTIVE-SWAP: No operations running on old profile', currentProfileId, '- swap complete without restart');
    }

    // Note: Don't immediately check new profile - let normal interval handle it
    // This prevents cascading swaps if multiple profiles are near limits
  }
}

/**
 * Get the singleton UsageMonitor instance
 */
export function getUsageMonitor(): UsageMonitor {
  return UsageMonitor.getInstance();
}
