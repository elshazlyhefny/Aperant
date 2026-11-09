/**
 * Active-profile resolution for the usage monitor.
 *
 * Reads settings.providerAccounts + globalPriorityOrder, picks the first
 * account in the priority order and resolves its credential/baseUrl through a
 * per-account-type resolver table. The `needsReauthProfiles` set stays owned
 * by UsageMonitor and is passed in through the dependency object.
 */

import { homedir } from 'os';
import { getClaudeProfileManager } from '../../claude-profile-manager';
import { loadProfilesFile } from '../../services/profile/profile-manager';
import type { ProviderAccount } from '../../../shared/types/provider-account';
import { getCredentialsFromKeychain } from '../credential-utils';
import { ensureValidToken } from '../token-refresh';
import { ensureValidCodexToken } from '../../ai/auth/codex-oauth';
import { readSettingsFileAsync, writeSettingsFile } from '../../settings-utils';
import { getCredentialFingerprint } from './usage-log';
import type { UsageLogger } from './usage-log';
import type { ActiveProfileResult } from './types';

export interface ActiveProfileResolverDeps {
  needsReauthProfiles: Set<string>;
  log: Pick<UsageLogger, 'debugLog' | 'traceLog'>;
}

type AccountResolver = (
  account: ProviderAccount,
  deps: ActiveProfileResolverDeps
) => Promise<ActiveProfileResult | null>;

async function resolveAnthropicOAuth(
  account: ProviderAccount,
  deps: ActiveProfileResolverDeps
): Promise<ActiveProfileResult | null> {
  const { needsReauthProfiles, log } = deps;
  const claudeProfileId = account.claudeProfileId;
  if (!claudeProfileId) {
    log.traceLog('[UsageMonitor:TRACE] Anthropic OAuth account missing claudeProfileId:', account.id);
    return null;
  }

  const profileManager = getClaudeProfileManager();
  const claudeProfile = profileManager.getProfile(claudeProfileId);
  if (!claudeProfile || !claudeProfile.configDir) {
    log.traceLog('[UsageMonitor:TRACE] ClaudeProfile not found or missing configDir for id:', claudeProfileId);
    return null;
  }

  const configDir = claudeProfile.configDir.startsWith('~')
    ? claudeProfile.configDir.replace(/^~/, homedir())
    : claudeProfile.configDir;

  // Get a fresh OAuth token (proactively refresh if near expiry)
  let credential: string | undefined;
  try {
    const tokenResult = await ensureValidToken(configDir);

    if (tokenResult.wasRefreshed) {
      log.debugLog('[UsageMonitor] Proactively refreshed OAuth token for active account: ' + account.name, {
        tokenFingerprint: getCredentialFingerprint(tokenResult.token)
      });
      if (tokenResult.persistenceFailed) {
        console.warn('[UsageMonitor] Token refreshed but persistence failed for account: ' + account.name +
          ' - user should re-authenticate to avoid auth errors on next restart');
        needsReauthProfiles.add(account.id);
      } else {
        needsReauthProfiles.delete(account.id);
      }
    }

    if (tokenResult.token) {
      credential = tokenResult.token;
      // Valid token obtained — clear any stale needs-reauth flag
      if (!tokenResult.persistenceFailed) {
        needsReauthProfiles.delete(account.id);
      }
    } else if (tokenResult.error) {
      log.traceLog('[UsageMonitor:TRACE] Token validation failed for active account:', tokenResult.error);
      if (tokenResult.errorCode === 'invalid_grant') {
        needsReauthProfiles.add(account.id);
      }
      if (tokenResult.errorCode === 'missing_credentials') {
        needsReauthProfiles.add(account.id);
      }
    }
  } catch (error) {
    log.traceLog('[UsageMonitor:TRACE] ensureValidToken failed for active account:', error);
  }

  // Fallback: direct keychain read
  if (!credential) {
    const keychainCreds = getCredentialsFromKeychain(configDir);
    credential = keychainCreds.token ?? undefined;
    if (credential) {
      // Got a valid token from keychain fallback — clear stale needs-reauth flag
      needsReauthProfiles.delete(account.id);
    } else {
      log.traceLog('[UsageMonitor:TRACE] No token in keychain for Anthropic OAuth account: ' + account.name);
      needsReauthProfiles.add(account.id);
    }
  }

  // Discover email from keychain if not persisted on the account
  let email: string | undefined = account.email;
  if (!email) {
    const keychainCreds = getCredentialsFromKeychain(configDir);
    email = keychainCreds.email ?? undefined;

    // Persist discovered email back to settings asynchronously (non-blocking)
    if (email) {
      const discoveredEmail = email;
      const accountId = account.id;
      readSettingsFileAsync().then(currentSettings => {
        if (!currentSettings) return;
        const accounts = (currentSettings.providerAccounts as ProviderAccount[] | undefined) ?? [];
        const target = accounts.find(a => a.id === accountId);
        if (target && !target.email) {
          target.email = discoveredEmail;
          try {
            writeSettingsFile(currentSettings);
          } catch {
            // Non-critical — email will be discovered again next poll
          }
        }
      }).catch(() => {});
    }
  }

  log.traceLog('[UsageMonitor:TRACE] Active auth type: Anthropic OAuth (via globalPriorityOrder)', {
    profileId: account.id,
    profileName: account.name,
    profileEmail: email
  });

  return {
    profileId: account.id,
    profileName: account.name,
    profileEmail: email,
    isAPIProfile: false,
    baseUrl: 'https://api.anthropic.com',
    credential
  };
}

async function resolveAnthropicApiKey(
  account: ProviderAccount,
  deps: ActiveProfileResolverDeps
): Promise<ActiveProfileResult | null> {
  const { log } = deps;
  const credential = account.apiKey;
  if (!credential) {
    log.traceLog('[UsageMonitor:TRACE] Anthropic API key account missing apiKey:', account.id);
    return null;
  }

  // Try to get baseUrl from the legacy profiles file if there's a matching API profile
  let baseUrl = account.baseUrl ?? 'https://api.anthropic.com';
  try {
    const profilesFile = await loadProfilesFile();
    const matchingProfile = profilesFile.profiles.find(p => p.apiKey === credential);
    if (matchingProfile?.baseUrl) {
      baseUrl = matchingProfile.baseUrl;
    }
  } catch {
    // Use account.baseUrl or default
  }

  log.traceLog('[UsageMonitor:TRACE] Active auth type: Anthropic API key (via globalPriorityOrder)', {
    profileId: account.id,
    profileName: account.name,
    baseUrl
  });

  return {
    profileId: account.id,
    profileName: account.name,
    profileEmail: account.email,
    isAPIProfile: true,
    baseUrl,
    credential
  };
}

async function resolveOpenAICodexOAuth(
  account: ProviderAccount,
  deps: ActiveProfileResolverDeps
): Promise<ActiveProfileResult | null> {
  const { log } = deps;
  // OpenAI/Codex OAuth account
  let credential: string | undefined;
  try {
    const codexToken = await ensureValidCodexToken();
    credential = codexToken ?? undefined;
  } catch (error) {
    log.traceLog('[UsageMonitor:TRACE] Failed to get Codex OAuth token:', error);
  }

  log.traceLog('[UsageMonitor:TRACE] Active auth type: Codex OAuth (via globalPriorityOrder)', {
    profileId: account.id,
    profileName: account.name,
    hasCredential: !!credential
  });

  return {
    profileId: account.id,
    profileName: account.name,
    profileEmail: account.email,
    isAPIProfile: false,
    baseUrl: 'https://chatgpt.com',
    credential
  };
}

async function resolveZai(
  account: ProviderAccount,
  deps: ActiveProfileResolverDeps
): Promise<ActiveProfileResult | null> {
  const { log } = deps;
  // Z.AI API key account
  const credential = account.apiKey;
  if (!credential) {
    log.traceLog('[UsageMonitor:TRACE] Z.AI account missing apiKey:', account.id);
    return null;
  }

  const baseUrl = account.baseUrl ?? 'https://api.z.ai';

  log.traceLog('[UsageMonitor:TRACE] Active auth type: Z.AI API key (via globalPriorityOrder)', {
    profileId: account.id,
    profileName: account.name,
    baseUrl
  });

  return {
    profileId: account.id,
    profileName: account.name,
    profileEmail: account.email,
    isAPIProfile: true,
    baseUrl,
    credential
  };
}

/** Resolvers keyed by `${provider}:${authType}`, or by provider alone (zai). */
const ACCOUNT_RESOLVERS: Record<string, AccountResolver> = {
  'anthropic:oauth': resolveAnthropicOAuth,
  'anthropic:api-key': resolveAnthropicApiKey,
  'openai:oauth': resolveOpenAICodexOAuth,
  zai: resolveZai
};

function findResolver(account: ProviderAccount): AccountResolver | undefined {
  return ACCOUNT_RESOLVERS[`${account.provider}:${account.authType}`] ?? ACCOUNT_RESOLVERS[account.provider];
}

/**
 * Determine which profile is active by reading globalPriorityOrder from settings.
 * The first account in the priority order is considered the active one.
 *
 * Supported: Anthropic OAuth, Anthropic API key, OpenAI/Codex OAuth, Z.AI API key.
 * Other providers return null (no usage monitoring supported).
 */
export async function resolveActiveProfile(
  deps: ActiveProfileResolverDeps
): Promise<ActiveProfileResult | null> {
  const { log } = deps;
  let settings: Record<string, unknown> | undefined;
  try {
    settings = await readSettingsFileAsync();
  } catch (error) {
    log.traceLog('[UsageMonitor:TRACE] Failed to read settings file:', error);
  }

  if (!settings) {
    log.traceLog('[UsageMonitor:TRACE] No settings available, falling back to legacy profile detection');
    return resolveActiveProfileLegacy(deps);
  }

  const providerAccounts = (settings.providerAccounts as ProviderAccount[] | undefined) ?? [];
  const globalPriorityOrder = (settings.globalPriorityOrder as string[] | undefined) ?? [];

  if (globalPriorityOrder.length === 0) {
    log.traceLog('[UsageMonitor:TRACE] No globalPriorityOrder in settings, falling back to legacy profile detection');
    return resolveActiveProfileLegacy(deps);
  }

  let account: ProviderAccount | undefined;
  for (const accountId of globalPriorityOrder) {
    const found = providerAccounts.find(a => a.id === accountId);
    if (found) {
      account = found;
      break;
    }
  }

  if (!account) {
    log.traceLog('[UsageMonitor:TRACE] No ProviderAccount found in globalPriorityOrder, falling back to legacy profile detection');
    return resolveActiveProfileLegacy(deps);
  }

  log.traceLog('[UsageMonitor:TRACE] Resolved active account from globalPriorityOrder:', {
    accountId: account.id,
    accountName: account.name,
    provider: account.provider,
    authType: account.authType
  });

  const resolver = findResolver(account);
  if (resolver) {
    return resolver(account, deps);
  }

  // Other providers (google, amazon-bedrock, etc.) — no usage monitoring support
  log.traceLog('[UsageMonitor:TRACE] Provider not supported for usage monitoring:', {
    provider: account.provider,
    accountId: account.id
  });
  return null;
}

/**
 * Legacy fallback when settings/globalPriorityOrder are not available:
 *   1. API profiles file (loadProfilesFile)
 *   2. ClaudeProfileManager.getActiveProfile()
 */
export async function resolveActiveProfileLegacy(
  deps: ActiveProfileResolverDeps
): Promise<ActiveProfileResult | null> {
  const { log } = deps;
// First, check if an API profile is active
try {
  const profilesFile = await loadProfilesFile();
  if (profilesFile.activeProfileId) {
    const activeAPIProfile = profilesFile.profiles.find(
      (p) => p.id === profilesFile.activeProfileId
    );
    if (activeAPIProfile?.apiKey) {
      log.traceLog('[UsageMonitor:TRACE] [Legacy] Active auth type: API Profile', {
        profileId: activeAPIProfile.id,
        profileName: activeAPIProfile.name,
        baseUrl: activeAPIProfile.baseUrl
      });
      return {
        profileId: activeAPIProfile.id,
        profileName: activeAPIProfile.name,
        isAPIProfile: true,
        baseUrl: activeAPIProfile.baseUrl,
        credential: activeAPIProfile.apiKey
      };
    }
  }
} catch (error) {
  log.traceLog('[UsageMonitor:TRACE] [Legacy] Failed to load API profiles:', error);
}

// Fall back to Claude OAuth profile
const profileManager = getClaudeProfileManager();
const activeOAuthProfile = profileManager.getActiveProfile();

if (!activeOAuthProfile) {
  log.debugLog('[UsageMonitor] [Legacy] No active profile found');
  return null;
}

let profileEmail = activeOAuthProfile.email;
if (!profileEmail) {
  const keychainCreds = getCredentialsFromKeychain(activeOAuthProfile.configDir);
  profileEmail = keychainCreds.email ?? undefined;
}

// Get credential via ensureValidToken
let credential: string | undefined;
try {
  const tokenResult = await ensureValidToken(activeOAuthProfile.configDir);
  if (tokenResult.token) {
    credential = tokenResult.token;
  }
} catch {
  const keychainCreds = getCredentialsFromKeychain(activeOAuthProfile.configDir);
  credential = keychainCreds.token ?? undefined;
}

log.traceLog('[UsageMonitor:TRACE] [Legacy] Active auth type: OAuth Profile', {
  profileId: activeOAuthProfile.id,
  profileName: activeOAuthProfile.name,
  profileEmail
});

return {
  profileId: activeOAuthProfile.id,
  profileName: activeOAuthProfile.name,
  profileEmail,
  isAPIProfile: false,
  baseUrl: 'https://api.anthropic.com',
  credential
};
}
