/**
 * Credential resolution for the usage monitor.
 *
 * The `needsReauthProfiles` set stays owned by UsageMonitor and is passed in
 * through the dependency object so both sides mutate the same instance.
 */

import { getClaudeProfileManager } from '../../claude-profile-manager';
import { loadProfilesFile } from '../../services/profile/profile-manager';
import type { ProviderAccount } from '../../../shared/types/provider-account';
import { getCredentialsFromKeychain } from '../credential-utils';
import { ensureValidToken } from '../token-refresh';
import { ensureValidCodexToken } from '../../ai/auth/codex-oauth';
import { readSettingsFileAsync } from '../../settings-utils';
import { getCredentialFingerprint } from './usage-log';
import type { UsageLogger } from './usage-log';

export interface CredentialResolverDeps {
  needsReauthProfiles: Set<string>;
  log: Pick<UsageLogger, 'debugLog' | 'traceLog'>;
}

/**
 * Resolve the credential for the active profile:
 * 1. API profile apiKey
 * 2. Codex OAuth (via globalPriorityOrder)
 * 3. Claude OAuth (ensureValidToken with keychain fallback)
 */
export async function resolveActiveCredential(
  deps: CredentialResolverDeps
): Promise<string | undefined> {
  const { needsReauthProfiles, log } = deps;

  // Try API profile first (highest priority)
  try {
    const profilesFile = await loadProfilesFile();
    if (profilesFile.activeProfileId) {
      const activeProfile = profilesFile.profiles.find(
        (p) => p.id === profilesFile.activeProfileId
      );
      if (activeProfile?.apiKey) {
        log.traceLog('[UsageMonitor:TRACE] Using API profile credential: ' + activeProfile.name);
        return activeProfile.apiKey;
      }
    }
  } catch (error) {
    // API profile loading failed, fall through to OAuth
    log.traceLog('[UsageMonitor:TRACE] Failed to load API profiles, falling back to OAuth:', error);
  }

  // Check for Codex OAuth token (OpenAI)
  try {
    const settings = await readSettingsFileAsync();
    if (settings) {
      const providerAccounts = (settings.providerAccounts as ProviderAccount[] | undefined) ?? [];
      const queue = (settings.globalPriorityOrder as string[] | undefined) ?? [];
      for (const accountId of queue) {
        const account = providerAccounts.find(a => a.id === accountId);
        if (account?.provider === 'openai' && account.authType === 'oauth') {
          const codexToken = await ensureValidCodexToken();
          if (codexToken) {
            log.traceLog('[UsageMonitor:TRACE] Using Codex OAuth token', {
              tokenFingerprint: getCredentialFingerprint(codexToken)
            });
            return codexToken;
          }
          log.traceLog('[UsageMonitor:TRACE] Codex OAuth token not available');
          break;
        }
      }
    }
  } catch (error) {
    log.traceLog('[UsageMonitor:TRACE] Failed to get Codex token, falling back to Claude OAuth:', error);
  }

  // Fall back to Claude OAuth profile - use ensureValidToken for proactive refresh
  const profileManager = getClaudeProfileManager();
  const activeProfile = profileManager.getActiveProfile();
  if (activeProfile) {
    // Use ensureValidToken to proactively refresh tokens before they expire
    // This prevents 401 errors during overnight autonomous operation
    try {
      const tokenResult = await ensureValidToken(activeProfile.configDir);

      if (tokenResult.wasRefreshed) {
        log.debugLog('[UsageMonitor] Proactively refreshed token for profile: ' + activeProfile.name, {
          tokenFingerprint: getCredentialFingerprint(tokenResult.token)
        });

        // Check if token refresh succeeded but persistence failed
        // The token works for this session but will be lost on restart
        if (tokenResult.persistenceFailed) {
          console.warn('[UsageMonitor] Token refreshed but persistence failed for profile: ' + activeProfile.name +
            ' - user should re-authenticate to avoid auth errors on next restart');
          needsReauthProfiles.add(activeProfile.id);
        } else {
          // Token was refreshed and persisted successfully - clear from needsReauth if present
          needsReauthProfiles.delete(activeProfile.id);
        }
      }

      if (tokenResult.token) {
        // Valid token obtained — clear any stale needs-reauth flag
        if (!tokenResult.persistenceFailed) {
          needsReauthProfiles.delete(activeProfile.id);
        }
        log.traceLog('[UsageMonitor:TRACE] Using OAuth token for profile: ' + activeProfile.name, {
          tokenFingerprint: getCredentialFingerprint(tokenResult.token),
          wasRefreshed: tokenResult.wasRefreshed
        });
        return tokenResult.token;
      }

      // Token unavailable - log the error
      if (tokenResult.error) {
        log.traceLog('[UsageMonitor:TRACE] Token validation failed:', tokenResult.error);

        // Check for invalid_grant error - indicates refresh token is permanently invalid
        // and user needs to manually re-authenticate
        if (tokenResult.errorCode === 'invalid_grant') {
          log.traceLog('[UsageMonitor:TRACE] Profile needs re-authentication (invalid refresh token): ' + activeProfile.name);
          needsReauthProfiles.add(activeProfile.id);
        }

        // Check for missing_credentials error - indicates no token in credential store
        // User needs to authenticate via /login
        if (tokenResult.errorCode === 'missing_credentials') {
          log.traceLog('[UsageMonitor:TRACE] Profile needs authentication (no credentials found): ' + activeProfile.name);
          needsReauthProfiles.add(activeProfile.id);
        }
      }
    } catch (error) {
      console.error('[UsageMonitor] ensureValidToken threw error:', error);
    }

    // Fallback: Try direct keychain read (e.g., if refresh token unavailable)
    const keychainCreds = getCredentialsFromKeychain(activeProfile.configDir);
    if (keychainCreds.token) {
      // Got a valid token from keychain fallback — clear stale needs-reauth flag
      needsReauthProfiles.delete(activeProfile.id);
      log.traceLog('[UsageMonitor:TRACE] Using fallback OAuth token from Keychain for profile: ' + activeProfile.name, {
        tokenFingerprint: getCredentialFingerprint(keychainCreds.token)
      });
      return keychainCreds.token;
    }

    // Keychain read also failed
    if (keychainCreds.error) {
      log.traceLog('[UsageMonitor:TRACE] Keychain access failed:', keychainCreds.error);
    } else {
      log.traceLog('[UsageMonitor:TRACE] No token in Keychain for profile: ' + activeProfile.name +
        ' - user may need to re-authenticate with claude /login');
    }

    // Mark profile as needing re-authentication since credentials are missing
    needsReauthProfiles.add(activeProfile.id);
  }

  // No credential available
  log.traceLog('[UsageMonitor:TRACE] No credential available (no API or OAuth profile active)');
  return undefined;
}

export interface InactiveProfileToken {
  token: string;
  wasRefreshed: boolean;
}

/**
 * Acquire a token for an inactive profile (ensureValidToken with keychain
 * fallback). Returns null when no credentials could be found.
 */
export async function resolveInactiveProfileToken(
  deps: CredentialResolverDeps,
  profile: { id: string; name: string },
  expandedConfigDir: string
): Promise<InactiveProfileToken | null> {
  const { needsReauthProfiles, log } = deps;

  // Use ensureValidToken to proactively refresh the token if near expiry
  // This is critical for inactive profiles whose tokens may have expired
  let token: string | null = null;
  let wasRefreshed = false;

  try {
    const tokenResult = await ensureValidToken(expandedConfigDir);

    if (tokenResult.wasRefreshed) {
      log.debugLog('[UsageMonitor] Proactively refreshed token for inactive profile: ' + profile.name, {
        tokenFingerprint: getCredentialFingerprint(tokenResult.token)
      });
      wasRefreshed = true;

      // Check if token refresh succeeded but persistence failed
      // The token works for this session but will be lost on restart
      if (tokenResult.persistenceFailed) {
        console.warn('[UsageMonitor] Token refreshed but persistence failed for profile: ' + profile.name +
          ' - user should re-authenticate to avoid auth errors on next restart');
        needsReauthProfiles.add(profile.id);
      } else {
        // Token was refreshed and persisted successfully - clear from needsReauth if present
        needsReauthProfiles.delete(profile.id);
      }
    }

    token = tokenResult.token;

    // If we got a valid token (regardless of refresh), clear the needs-reauth flag.
    // This handles the case where the startup null-check in getAllProfilesUsage()
    // incorrectly marked the profile (sync keychain read returned null, but async
    // ensureValidToken succeeds later).
    if (token && !tokenResult.persistenceFailed) {
      needsReauthProfiles.delete(profile.id);
    }

    if (tokenResult.error) {
      log.debugLog('[UsageMonitor] Token validation failed for inactive profile: ' + profile.name, tokenResult.error);

      // Check for invalid_grant error - indicates refresh token is invalid
      // and user needs to manually re-authenticate
      if (tokenResult.errorCode === 'invalid_grant') {
        log.debugLog('[UsageMonitor] Profile needs re-authentication (invalid refresh token): ' + profile.name);
        needsReauthProfiles.add(profile.id);
      }

      // Check for missing_credentials error - indicates no token in credential store
      // User needs to authenticate via /login
      if (tokenResult.errorCode === 'missing_credentials') {
        log.debugLog('[UsageMonitor] Profile needs authentication (no credentials found): ' + profile.name);
        needsReauthProfiles.add(profile.id);
      }
    }
  } catch (error) {
    log.debugLog('[UsageMonitor] ensureValidToken failed for inactive profile: ' + profile.name, error);
  }

  // Fallback: Try direct keychain read if ensureValidToken failed
  if (!token) {
    const keychainCreds = getCredentialsFromKeychain(expandedConfigDir);
    token = keychainCreds.token;

    if (!token) {
      log.debugLog('[UsageMonitor] No keychain credentials for inactive profile: ' + profile.name);
      // Mark profile as needing re-authentication since credentials are missing
      needsReauthProfiles.add(profile.id);
      return null;
    }
    // Got a valid token from keychain fallback — clear stale needs-reauth flag
    needsReauthProfiles.delete(profile.id);
  }

  return { token, wasRefreshed };
}
