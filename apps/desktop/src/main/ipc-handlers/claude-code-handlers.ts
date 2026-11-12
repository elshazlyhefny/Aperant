/**
 * Claude Code CLI Handlers
 *
 * IPC handlers for Claude Code CLI version checking and installation.
 * Provides functionality to:
 * - Check installed vs latest version
 * - Open terminal with installation command
 */

import { ipcMain } from 'electron';
import { spawn, execFile } from 'child_process';
import { existsSync, readFileSync, promises as fsPromises } from 'fs';
import { mkdir, rename, unlink } from 'fs/promises';
import path from 'path';
import os from 'os';
import { promisify } from 'util';
import { IPC_CHANNELS, DEFAULT_APP_SETTINGS } from '../../shared/constants';
import type { IPCResult } from '../../shared/types';
import type { ClaudeCodeVersionInfo, ClaudeInstallationList, ClaudeInstallationInfo } from '../../shared/types/cli';
import { getToolInfo, configureTools, sortNvmVersionDirs, getClaudeDetectionPaths, validateClaudeAsync } from '../cli-tool-manager';
import { readSettingsFile, writeSettingsFile } from '../settings-utils';
import { isSecurePath, getWhereExePath, getTaskkillExePath } from '../utils/windows-paths';
import { isWindows, isMacOS, isLinux } from '../platform';
import { getClaudeProfileManager } from '../claude-profile-manager';
import { isValidConfigDir } from '../utils/config-path-validator';
import { clearKeychainCache, getCredentialsFromKeychain, updateProfileSubscriptionMetadata } from '../claude-profile/credential-utils';
import { getUsageMonitor } from '../claude-profile/usage-monitor';
import semver from 'semver';

import { appLog } from '../app-logger';
import { launchTerminal } from './task/tool-detection/terminal-launch';
const execFileAsync = promisify(execFile);

// Cache for latest version (avoid hammering npm registry)
let cachedLatestVersion: { version: string; timestamp: number } | null = null;
let cachedVersionList: { versions: string[]; timestamp: number } | null = null;
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
const VERSION_LIST_CACHE_DURATION_MS = 60 * 60 * 1000; // 1 hour for version list

/**
 * Scan all known locations for Claude CLI installations.
 * Returns all found installations with their paths, versions, and sources.
 *
 * Uses getClaudeDetectionPaths() from cli-tool-manager.ts as the single source
 * of truth for detection paths to avoid duplication and ensure consistency.
 *
 * @see cli-tool-manager.ts getClaudeDetectionPaths() for path configuration
 */
async function scanClaudeInstallations(activePath: string | null): Promise<ClaudeInstallationInfo[]> {
  const installations: ClaudeInstallationInfo[] = [];
  const seenPaths = new Set<string>();
  const homeDir = os.homedir();

  // Get detection paths from cli-tool-manager (single source of truth)
  const detectionPaths = getClaudeDetectionPaths(homeDir);

  const addInstallation = async (
    cliPath: string,
    source: ClaudeInstallationInfo['source']
  ) => {
    // Normalize path for comparison
    const normalizedPath = path.resolve(cliPath);
    if (seenPaths.has(normalizedPath)) return;

    if (!existsSync(cliPath)) return;

    // Security validation: reject paths with shell metacharacters or directory traversal
    if (!isSecurePath(cliPath)) {
      console.warn('[Claude Code] Rejecting insecure path:', cliPath);
      return;
    }

    const validation = await validateClaudeAsync(cliPath);
    if (!validation.valid) {
      console.warn('[Claude Code] CLI validation failed for', cliPath, ':', validation.message);
      return;
    }
    const version = validation.version ?? null;

    seenPaths.add(normalizedPath);
    installations.push({
      path: normalizedPath,
      version,
      source,
      isActive: activePath ? path.resolve(activePath) === normalizedPath : false,
    });
  };

  // 1. Check user-configured path first (if set)
  if (activePath && existsSync(activePath)) {
    await addInstallation(activePath, 'user-config');
  }

  // 2. Check system PATH via which/where
  try {
    if (isWindows()) {
      const result = await execFileAsync(getWhereExePath(), ['claude'], { timeout: 5000 });
      const paths = result.stdout.trim().split('\n').filter(p => p.trim());
      for (const p of paths) {
        await addInstallation(p.trim(), 'system-path');
      }
    } else {
      const result = await execFileAsync('which', ['-a', 'claude'], { timeout: 5000 });
      const paths = result.stdout.trim().split('\n').filter(p => p.trim());
      for (const p of paths) {
        await addInstallation(p.trim(), 'system-path');
      }
    }
  } catch {
    // which/where failed, continue with other methods
  }

  // 3. Homebrew paths (macOS) - from getClaudeDetectionPaths
  if (isMacOS()) {
    for (const p of detectionPaths.homebrewPaths) {
      await addInstallation(p, 'homebrew');
    }
  }

  // 4. NVM paths (Unix) - check Node.js version manager
  if (!isWindows() && existsSync(detectionPaths.nvmVersionsDir)) {
    try {
      const entries = await fsPromises.readdir(detectionPaths.nvmVersionsDir, { withFileTypes: true });
      const versionDirs = sortNvmVersionDirs(entries);
      for (const versionName of versionDirs) {
        const nvmClaudePath = path.join(detectionPaths.nvmVersionsDir, versionName, 'bin', 'claude');
        await addInstallation(nvmClaudePath, 'nvm');
      }
    } catch {
      // Failed to read NVM directory
    }
  }

  // 5. Platform-specific standard locations - from getClaudeDetectionPaths
  for (const p of detectionPaths.platformPaths) {
    await addInstallation(p, 'system-path');
  }

  // 6. Additional common paths not in getClaudeDetectionPaths (for broader scanning)
  const additionalPaths = isWindows()
    ? [] // Windows paths are well covered by detectionPaths.platformPaths
    : [
        path.join(homeDir, '.npm-global', 'bin', 'claude'),
        path.join(homeDir, '.yarn', 'bin', 'claude'),
        path.join(homeDir, '.claude', 'local', 'claude'),
        path.join(homeDir, 'node_modules', '.bin', 'claude'),
      ];

  for (const p of additionalPaths) {
    await addInstallation(p, 'system-path');
  }

  // Mark the first installation as active if none is explicitly active
  if (installations.length > 0 && !installations.some(i => i.isActive)) {
    installations[0].isActive = true;
  }

  return installations;
}

/**
 * Fetch the latest version of Claude Code from npm registry
 * @param currentInstalled - Optional currently installed version. If provided and newer than
 *                           cached latest, cache will be invalidated and fresh data fetched.
 *                           This handles the case where CLI was updated while app was running.
 */
async function fetchLatestVersion(currentInstalled?: string | null): Promise<string> {
  // Check cache first
  if (cachedLatestVersion && Date.now() - cachedLatestVersion.timestamp < CACHE_DURATION_MS) {
    const cachedVersion = cachedLatestVersion.version;

    // Invalidate cache if installed version is newer than cached latest
    // This handles the case where CLI was updated while app was running
    if (currentInstalled && cachedVersion) {
      try {
        const cleanInstalled = currentInstalled.replace(/^v/, '');
        const cleanCached = cachedVersion.replace(/^v/, '');
        if (semver.valid(cleanInstalled) && semver.valid(cleanCached) &&
            semver.gt(cleanInstalled, cleanCached)) {
          console.warn('[Claude Code] Installed version newer than cached latest, invalidating cache');
          cachedLatestVersion = null;
          // Fall through to fetch fresh from npm
        } else {
          return cachedVersion;
        }
      } catch {
        // If semver comparison fails, return cached version
        return cachedVersion;
      }
    } else {
      return cachedVersion;
    }
  }

  try {
    const response = await fetch('https://registry.npmjs.org/@anthropic-ai/claude-code/latest', {
      headers: {
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    const version = data.version;

    if (!version || typeof version !== 'string') {
      throw new Error('Invalid version format from npm registry');
    }

    // Cache the result
    cachedLatestVersion = { version, timestamp: Date.now() };
    return version;
  } catch (error) {
    console.error('[Claude Code] Failed to fetch latest version:', error);
    // Return cached version if available, even if expired
    if (cachedLatestVersion) {
      return cachedLatestVersion.version;
    }
    throw error;
  }
}

/**
 * Fetch available versions of Claude Code from npm registry
 * Returns versions sorted by semver descending (newest first)
 * Limited to last 20 versions for performance
 */
async function fetchAvailableVersions(): Promise<string[]> {
  // Check cache first
  if (cachedVersionList && Date.now() - cachedVersionList.timestamp < VERSION_LIST_CACHE_DURATION_MS) {
    return cachedVersionList.versions;
  }

  try {
    const response = await fetch('https://registry.npmjs.org/@anthropic-ai/claude-code', {
      headers: {
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(15000), // 15 second timeout
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    const versions = Object.keys(data.versions || {});

    if (!versions.length) {
      throw new Error('No versions found in npm registry');
    }

    // Sort by semver descending (newest first) and take last 20
    const sortedVersions = versions
      .filter(v => semver.valid(v)) // Only valid semver versions
      .sort((a, b) => semver.rcompare(a, b)) // Sort descending
      .slice(0, 20); // Limit to 20 versions

    // Validate we have versions after filtering
    if (sortedVersions.length === 0) {
      throw new Error('No valid semver versions found in npm registry');
    }

    // Cache the result
    cachedVersionList = { versions: sortedVersions, timestamp: Date.now() };
    return sortedVersions;
  } catch (error) {
    console.error('[Claude Code] Failed to fetch available versions:', error);
    // Return cached versions if available, even if expired
    if (cachedVersionList) {
      return cachedVersionList.versions;
    }
    throw error;
  }
}

/**
 * Get the platform-specific install command for a specific version of Claude Code
 * @param version - The version to install (e.g., "1.0.5")
 */
function getInstallVersionCommand(version: string): string {
  if (isWindows()) {
    // Windows: kill running Claude processes first, then install specific version
    return `"${getTaskkillExePath()}" /IM claude.exe /F 2>nul; claude install --force ${version}`;
  } else {
    // macOS/Linux: kill running Claude processes first, then install specific version
    return `pkill -x claude 2>/dev/null; sleep 1; claude install --force ${version}`;
  }
}

/**
 * Get the platform-specific install command for Claude Code
 * @param isUpdate - If true, Claude is already installed and we just need to update
 */
function getInstallCommand(isUpdate: boolean): string {
  if (isWindows()) {
    if (isUpdate) {
      // Update: kill running Claude processes first, then update with --force
      return `"${getTaskkillExePath()}" /IM claude.exe /F 2>nul; claude install --force latest`;
    }
    return 'irm https://claude.ai/install.ps1 | iex';
  } else {
    if (isUpdate) {
      // Update: kill running Claude processes first, then update with --force
      // pkill sends SIGTERM to gracefully stop Claude processes
      return 'pkill -x claude 2>/dev/null; sleep 1; claude install --force latest';
    }
    // Fresh install: use the full install script
    return 'curl -fsSL https://claude.ai/install.sh | bash -s -- latest';
  }
}

/**
 * Open a terminal with the given command
 * Uses the user's preferred terminal from settings
 */
export async function openTerminalWithCommand(command: string): Promise<void> {
  const settings = readSettingsFile();
  const preferredTerminal = settings?.preferredTerminal as string | undefined;
  await launchTerminal({ terminal: preferredTerminal, command });
}

/**
 * Result of authentication check
 */
interface AuthCheckResult {
  authenticated: boolean;
  email?: string;
  /** The full oauthAccount data from .claude.json (if available) */
  oauthAccount?: {
    emailAddress?: string;
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: string;
    [key: string]: unknown;
  };
}

/**
 * Check if a profile's config directory has authentication.
 * Checks multiple locations based on platform:
 * - macOS: .claude.json with oauthAccount containing emailAddress
 * - Linux: .credentials.json OR .claude.json (Claude uses different storage on Linux)
 * - Windows: .claude.json, .credentials.json, AND Windows Credential Manager
 *
 * Also returns the full oauthAccount data so we can update the profile token.
 */
function checkProfileAuthentication(configDir: string): AuthCheckResult {
  // Validate path to prevent reading arbitrary files
  if (!isValidConfigDir(configDir)) {
    console.error('[Claude Code] Security: Rejected authentication check for invalid configDir:', configDir);
    return { authenticated: false };
  }

  // Expand ~ to home directory
  const expandedConfigDir = configDir.startsWith('~')
    ? path.join(os.homedir(), configDir.slice(1))
    : configDir;

  const claudeJsonPath = path.join(expandedConfigDir, '.claude.json');
  const credentialsJsonPath = path.join(expandedConfigDir, '.credentials.json');

  try {
    // First check .claude.json (primary on macOS/Windows, also used on some Linux setups)
    if (existsSync(claudeJsonPath)) {
      const content = readFileSync(claudeJsonPath, 'utf-8');
      const data = JSON.parse(content);

      // Check for oauthAccount with emailAddress
      if (data.oauthAccount?.emailAddress) {
        return {
          authenticated: true,
          email: data.oauthAccount.emailAddress,
          oauthAccount: data.oauthAccount
        };
      }
    }

    // On Linux and Windows, also check .credentials.json (Claude CLI stores tokens here)
    if ((isLinux() || isWindows()) && existsSync(credentialsJsonPath)) {
      const content = readFileSync(credentialsJsonPath, 'utf-8');
      const data = JSON.parse(content);

      // .credentials.json may have different structure
      // Check for claudeAiOauth or oauthAccount
      if (data.claudeAiOauth) {
        // Extract email from claudeAiOauth if available
        const email = data.claudeAiOauth.email || data.claudeAiOauth.emailAddress;
        return {
          authenticated: true,
          email: email,
          oauthAccount: data.claudeAiOauth
        };
      }

      if (data.oauthAccount?.emailAddress) {
        return {
          authenticated: true,
          email: data.oauthAccount.emailAddress,
          oauthAccount: data.oauthAccount
        };
      }

      // If .credentials.json exists with any oauth-related content, consider it authenticated
      if (data.accessToken || data.refreshToken || data.token) {
        return {
          authenticated: true,
          email: undefined, // Email might not be available in this format
          oauthAccount: {
            accessToken: data.accessToken || data.token,
            refreshToken: data.refreshToken
          }
        };
      }
    }

    // On Windows, also check Windows Credential Manager as a fallback
    // Credentials may be stored ONLY in Credential Manager (not in files)
    if (isWindows()) {
      const keychainCreds = getCredentialsFromKeychain(expandedConfigDir);
      if (keychainCreds.token) {
        return {
          authenticated: true,
          email: keychainCreds.email || undefined,
          oauthAccount: {
            accessToken: keychainCreds.token,
            emailAddress: keychainCreds.email || undefined
          }
        };
      }
    }

    return { authenticated: false };
  } catch (error) {
    console.error('[Claude Code] Error checking authentication:', error);
    return { authenticated: false };
  }
}

/**
 * Register Claude Code IPC handlers
 */
export function registerClaudeCodeHandlers(): void {
  // Check Claude Code version
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_CODE_CHECK_VERSION,
    async (): Promise<IPCResult<ClaudeCodeVersionInfo>> => {
      try {
        console.warn('[Claude Code] Checking version...');

        // Get installed version via cli-tool-manager
        let detectionResult;
        try {
          detectionResult = getToolInfo('claude');
          console.warn('[Claude Code] Detection result:', JSON.stringify(detectionResult, null, 2));
        } catch (detectionError) {
          console.error('[Claude Code] Detection error:', detectionError);
          throw new Error(`Detection failed: ${detectionError instanceof Error ? detectionError.message : 'Unknown error'}`);
        }

        const installed = detectionResult.found ? detectionResult.version || null : null;
        console.warn('[Claude Code] Installed version:', installed);

        // Fetch latest version from npm
        // Pass installed version to invalidate cache if installed > cached (handles CLI update while app running)
        let latest: string;
        try {
          console.warn('[Claude Code] Fetching latest version from npm...');
          latest = await fetchLatestVersion(installed);
          console.warn('[Claude Code] Latest version:', latest);
        } catch (error) {
          console.warn('[Claude Code] Failed to fetch latest version, continuing with unknown:', error);
          // If we can't fetch latest, still return installed info
          return {
            success: true,
            data: {
              installed,
              latest: 'unknown',
              isOutdated: false,
              path: detectionResult.path,
              detectionResult,
            },
          };
        }

        // Compare versions
        let isOutdated = false;
        if (installed && latest !== 'unknown') {
          try {
            // Clean version strings (remove 'v' prefix if present)
            const cleanInstalled = installed.replace(/^v/, '');
            const cleanLatest = latest.replace(/^v/, '');
            isOutdated = semver.lt(cleanInstalled, cleanLatest);
          } catch {
            // If semver comparison fails, assume not outdated
            isOutdated = false;
          }
        }

        console.warn('[Claude Code] Check complete:', { installed, latest, isOutdated });
        return {
          success: true,
          data: {
            installed,
            latest,
            isOutdated,
            path: detectionResult.path,
            detectionResult,
          },
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error('[Claude Code] Check failed:', errorMsg, error);
        return {
          success: false,
          error: `Failed to check Claude Code version: ${errorMsg}`,
        };
      }
    }
  );

  // Install Claude Code (open terminal with install command)
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_CODE_INSTALL,
    async (): Promise<IPCResult<{ command: string }>> => {
      try {
        // Check if Claude is already installed to determine if this is an update
        let isUpdate = false;
        try {
          const detectionResult = getToolInfo('claude');
          isUpdate = detectionResult.found && !!detectionResult.version;
          console.warn('[Claude Code] Is update:', isUpdate, 'detected version:', detectionResult.version);
        } catch {
          // Detection failed, assume fresh install
          isUpdate = false;
        }

        const command = getInstallCommand(isUpdate);
        console.warn('[Claude Code] Install command:', command);
        console.warn('[Claude Code] Opening terminal...');
        await openTerminalWithCommand(command);
        console.warn('[Claude Code] Terminal opened successfully');

        return {
          success: true,
          data: { command },
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error('[Claude Code] Install failed:', errorMsg, error);
        return {
          success: false,
          error: `Failed to open terminal for installation: ${errorMsg}`,
        };
      }
    }
  );

  // Get available Claude Code versions
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_CODE_GET_VERSIONS,
    async (): Promise<IPCResult<{ versions: string[] }>> => {
      try {
        appLog.info('[Claude Code] Fetching available versions...');
        const versions = await fetchAvailableVersions();
        appLog.info('[Claude Code] Found', versions.length, 'versions');
        return {
          success: true,
          data: { versions },
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error('[Claude Code] Failed to fetch versions:', errorMsg, error);
        return {
          success: false,
          error: `Failed to fetch available versions: ${errorMsg}`,
        };
      }
    }
  );

  // Install a specific version of Claude Code
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_CODE_INSTALL_VERSION,
    async (_event, version: string): Promise<IPCResult<{ command: string; version: string }>> => {
      try {
        // Validate version format
        if (!version || typeof version !== 'string') {
          throw new Error('Invalid version specified');
        }

        // Basic semver validation
        if (!semver.valid(version)) {
          throw new Error(`Invalid version format: ${version}`);
        }

        appLog.info('[Claude Code] Installing version:', version);
        const command = getInstallVersionCommand(version);
        appLog.info('[Claude Code] Install command:', command);
        appLog.info('[Claude Code] Opening terminal...');
        await openTerminalWithCommand(command);
        appLog.info('[Claude Code] Terminal opened successfully');

        return {
          success: true,
          data: { command, version },
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error('[Claude Code] Install version failed:', errorMsg, error);
        return {
          success: false,
          error: `Failed to install version: ${errorMsg}`,
        };
      }
    }
  );

  // Get all Claude CLI installations found on the system
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_CODE_GET_INSTALLATIONS,
    async (): Promise<IPCResult<ClaudeInstallationList>> => {
      try {
        appLog.info('[Claude Code] Scanning for installations...');

        // Get current active path from settings
        const settings = readSettingsFile();
        const activePath = settings?.claudePath as string | undefined;

        const installations = await scanClaudeInstallations(activePath || null);
        appLog.info('[Claude Code] Found', installations.length, 'installations');

        return {
          success: true,
          data: {
            installations,
            activePath: activePath || (installations.length > 0 ? installations[0].path : null),
          },
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error('[Claude Code] Failed to scan installations:', errorMsg, error);
        return {
          success: false,
          error: `Failed to scan Claude CLI installations: ${errorMsg}`,
        };
      }
    }
  );

  // Set the active Claude CLI path
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_CODE_SET_ACTIVE_PATH,
    async (_event, cliPath: string): Promise<IPCResult<{ path: string }>> => {
      try {
        appLog.info('[Claude Code] Setting active path:', cliPath);

        // Security validation: reject paths with shell metacharacters or directory traversal
        if (!isSecurePath(cliPath)) {
          throw new Error('Invalid path: contains potentially unsafe characters');
        }

        // Normalize path to prevent directory traversal
        const normalizedPath = path.resolve(cliPath);

        // Validate the path exists and is executable
        if (!existsSync(normalizedPath)) {
          throw new Error('Claude CLI not found at specified path');
        }

        const validation = await validateClaudeAsync(normalizedPath);
        const version = validation.version ?? null;
        if (!validation.valid) {
          console.warn('[Claude Code] CLI validation failed for', normalizedPath, ':', validation.message);
          throw new Error('Claude CLI at specified path is not valid or not executable');
        }

        // Save to settings using established pattern: merge with DEFAULT_APP_SETTINGS
        const currentSettings = readSettingsFile() || {};
        const mergedSettings = {
          ...DEFAULT_APP_SETTINGS,
          ...currentSettings,
          claudePath: normalizedPath,
        } as Record<string, unknown>;
        writeSettingsFile(mergedSettings);

        // Update CLI tool manager cache
        configureTools({ claudePath: normalizedPath });

        appLog.info('[Claude Code] Active path set:', normalizedPath, 'version:', version);

        return {
          success: true,
          data: { path: normalizedPath },
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error('[Claude Code] Failed to set active path:', errorMsg, error);
        return {
          success: false,
          error: `Failed to set active Claude CLI path: ${errorMsg}`,
        };
      }
    }
  );

  // Authenticate Claude profile - returns terminal config for embedded terminal
  // The frontend creates an embedded terminal with CLAUDE_CONFIG_DIR set,
  // and the terminal ID pattern enables automatic token capture on /login
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PROFILE_AUTHENTICATE,
    async (_event, profileId: string): Promise<IPCResult<{ terminalId: string; configDir: string }>> => {
      try {
        console.warn('[Claude Code] Authenticating profile:', profileId);

        const profileManager = getClaudeProfileManager();
        const profile = profileManager.getProfile(profileId);

        if (!profile) {
          return {
            success: false,
            error: `Profile not found: ${profileId}`
          };
        }

        // For default profile, use the default Claude config dir
        const configDir = profile.configDir || '~/.claude';

        // Validate path to prevent operations on arbitrary directories
        if (!isValidConfigDir(configDir)) {
          return {
            success: false,
            error: `Invalid config directory path: ${configDir}. Config directories must be within the user's home directory.`
          };
        }

        // Ensure the config directory exists
        const expandedConfigDir = configDir.startsWith('~')
          ? path.join(os.homedir(), configDir.slice(1))
          : configDir;

        // Create directory if it doesn't exist
        await mkdir(expandedConfigDir, { recursive: true });

        console.warn('[Claude Code] Config directory:', expandedConfigDir);

        // Backwards compatibility: If re-authenticating an existing profile that was
        // set up with the old setup-token system, we need to clear the existing
        // credentials so that /login opens the browser for fresh OAuth.
        // We back up the existing .claude.json to .claude.json.bak
        const claudeJsonPath = path.join(expandedConfigDir, '.claude.json');
        const claudeJsonBakPath = path.join(expandedConfigDir, '.claude.json.bak');

        // NOTE: We intentionally do NOT clean up .claude.json.bak here.
        // If both files exist, we cannot assume the previous auth succeeded - the app
        // may have crashed after /login wrote an incomplete .claude.json but before
        // VERIFY_AUTH ran. The backup may contain valid credentials needed for rollback.
        //
        // Backup cleanup happens safely in two places:
        // 1. VERIFY_AUTH handler (lines ~1339-1347): After confirming valid credentials
        // 2. Below (lines ~1229-1231): When creating a new backup (removes old backup first)

        if (existsSync(claudeJsonPath)) {
          try {
            const content = readFileSync(claudeJsonPath, 'utf-8');
            const data = JSON.parse(content);

            // Check if this has OAuth credentials (old setup-token or previous /login)
            if (data.oauthAccount) {
              console.warn('[Claude Code] Found existing OAuth credentials, backing up for re-authentication');

              // Remove old backup if exists
              if (existsSync(claudeJsonBakPath)) {
                await unlink(claudeJsonBakPath);
              }

              // Backup current credentials
              await rename(claudeJsonPath, claudeJsonBakPath);
              console.warn('[Claude Code] Backed up .claude.json to .claude.json.bak');
            }
          } catch (backupError) {
            // Non-fatal: if backup fails, /login might still work or show "already logged in"
            console.warn('[Claude Code] Could not backup existing credentials:', backupError);
          }
        }

        // Generate terminal ID with pattern: claude-login-{profileId}-{timestamp}
        // This pattern is used by cli-integration-handler.ts to identify
        // which profile to save captured OAuth tokens to
        const terminalId = `claude-login-${profileId}-${Date.now()}`;
        console.warn('[Claude Code] Generated terminal ID:', terminalId);

        return {
          success: true,
          data: {
            terminalId,
            configDir: expandedConfigDir
          }
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error('[Claude Code] Authentication failed:', errorMsg, error);
        return {
          success: false,
          error: `Failed to prepare authentication: ${errorMsg}`
        };
      }
    }
  );

  // Verify if a profile has been authenticated
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_PROFILE_VERIFY_AUTH,
    async (_event, profileId: string): Promise<IPCResult<{ authenticated: boolean; email?: string }>> => {
      try {
        console.warn('[Claude Code] Verifying auth for profile:', profileId);

        const profileManager = getClaudeProfileManager();
        const profile = profileManager.getProfile(profileId);

        if (!profile) {
          return {
            success: false,
            error: `Profile not found: ${profileId}`
          };
        }

        const configDir = profile.configDir || '~/.claude';
        const result = checkProfileAuthentication(configDir);

        console.warn('[Claude Code] Auth verification result:', result);

        // Expand configDir for backup restoration check
        const expandedConfigDir = configDir.startsWith('~')
          ? path.join(os.homedir(), configDir.slice(1))
          : configDir;

        const claudeJsonPath = path.join(expandedConfigDir, '.claude.json');
        const claudeJsonBakPath = path.join(expandedConfigDir, '.claude.json.bak');

        // If NOT authenticated AND backup exists, restore the backup
        // This handles cases where authentication was cancelled or failed
        if (!result.authenticated && existsSync(claudeJsonBakPath)) {
          try {
            console.warn('[Claude Code] Authentication failed and backup exists, restoring .claude.json.bak');

            // Remove incomplete .claude.json if it exists
            if (existsSync(claudeJsonPath)) {
              await unlink(claudeJsonPath);
            }

            // Restore the backup
            await rename(claudeJsonBakPath, claudeJsonPath);
            console.warn('[Claude Code] Restored .claude.json from backup');
          } catch (restoreError) {
            console.warn('[Claude Code] Failed to restore backup:', restoreError);
            // Non-fatal: user can manually restore from .claude.json.bak
          }
        }

        // If authenticated, update the profile with metadata from credentials
        // NOTE: We intentionally do NOT store the OAuth token in the profile.
        // Storing the token causes AutoClaude to use a stale cached token instead of
        // letting Claude CLI read fresh tokens from Keychain (which auto-refreshes).
        // By only storing metadata, we ensure getProfileEnv() uses CLAUDE_CONFIG_DIR,
        // which allows Claude CLI's working token refresh mechanism to be used.
        // See: docs/LONG_LIVED_AUTH_PLAN.md for full context.
        if (result.authenticated) {
          profile.isAuthenticated = true;

          if (result.email) {
            profile.email = result.email;
          }

          // Update subscription metadata from Keychain credentials
          // These are needed to display "Max" vs "Pro" in the UI
          updateProfileSubscriptionMetadata(profile, expandedConfigDir);

          // Save profile metadata (email, isAuthenticated, subscriptionType, rateLimitTier) but NOT the OAuth token
          profileManager.saveProfile(profile);

          // CRITICAL: Clear keychain cache for this profile's configDir
          // This ensures the new token is read from keychain instead of using a stale cached token
          // Without this, UsageMonitor would use the old cached token and show incorrect usage data
          clearKeychainCache(expandedConfigDir);
          console.warn('[Claude Code] Cleared keychain cache for profile after re-authentication:', profileId);

          // CRITICAL: Also clear the UsageMonitor's usage cache for this profile
          // This ensures fresh usage data is fetched from the API instead of using stale cached data
          // The keychain cache clear alone is not enough - we also need to clear the usage cache
          const usageMonitor = getUsageMonitor();
          usageMonitor.clearProfileUsageCache(profileId);
          console.warn('[Claude Code] Cleared usage cache for profile after re-authentication:', profileId);
          usageMonitor.checkNow();
          console.warn('[Claude Code] Triggered immediate usage check after re-authentication:', profileId);

          // Clean up backup file after successful authentication
          if (existsSync(claudeJsonBakPath)) {
            try {
              await unlink(claudeJsonBakPath);
              console.warn('[Claude Code] Cleaned up .claude.json.bak after successful auth');
            } catch (cleanupError) {
              console.warn('[Claude Code] Failed to clean up backup:', cleanupError);
              // Non-fatal: backup file can remain for safety
            }
          }
        }

        return {
          success: true,
          data: result
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error('[Claude Code] Auth verification failed:', errorMsg, error);
        return {
          success: false,
          error: `Failed to verify authentication: ${errorMsg}`
        };
      }
    }
  );

  // Run `claude auth login` as a subprocess (no terminal needed)
  // Same OAuth flow (opens browser → Anthropic consent → token saved to Keychain)
  // but without spawning a full PTY/xterm.js terminal
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_AUTH_LOGIN_SUBPROCESS,
    async (event, profileId: string): Promise<IPCResult<{ authenticated: boolean; email?: string }>> => {
      try {
        console.warn('[Claude Code] Starting auth login subprocess for profile:', profileId);

        const profileManager = getClaudeProfileManager();
        const profile = profileManager.getProfile(profileId);

        if (!profile) {
          return { success: false, error: `Profile not found: ${profileId}` };
        }

        // Resolve configDir (same logic as CLAUDE_PROFILE_AUTHENTICATE)
        const configDir = profile.configDir || '~/.claude';
        if (!isValidConfigDir(configDir)) {
          return { success: false, error: `Invalid config directory path: ${configDir}` };
        }

        const expandedConfigDir = configDir.startsWith('~')
          ? path.join(os.homedir(), configDir.slice(1))
          : configDir;

        await mkdir(expandedConfigDir, { recursive: true });

        // Backup existing .claude.json (same logic as CLAUDE_PROFILE_AUTHENTICATE)
        const claudeJsonPath = path.join(expandedConfigDir, '.claude.json');
        const claudeJsonBakPath = path.join(expandedConfigDir, '.claude.json.bak');

        if (existsSync(claudeJsonPath)) {
          try {
            const content = readFileSync(claudeJsonPath, 'utf-8');
            const data = JSON.parse(content);
            if (data.oauthAccount) {
              console.warn('[Claude Code] Found existing OAuth credentials, backing up for re-authentication');
              if (existsSync(claudeJsonBakPath)) {
                await unlink(claudeJsonBakPath);
              }
              await rename(claudeJsonPath, claudeJsonBakPath);
            }
          } catch (backupError) {
            console.warn('[Claude Code] Could not backup existing credentials:', backupError);
          }
        }

        // Resolve the claude binary path
        const claudeInfo = getToolInfo('claude');
        if (!claudeInfo.found || !claudeInfo.path) {
          return { success: false, error: 'Claude CLI not found. Please install Claude Code first.' };
        }

        const claudePath = claudeInfo.path;

        // Send progress: opening browser
        const sender = event.sender;
        sender.send(IPC_CHANNELS.CLAUDE_AUTH_LOGIN_PROGRESS, {
          status: 'authenticating',
          message: 'Opening browser for authentication...'
        });

        // Spawn `claude auth login` subprocess
        return new Promise<IPCResult<{ authenticated: boolean; email?: string }>>((resolve) => {
          const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CONFIG_DIR: expandedConfigDir };
          // Remove ELECTRON_RUN_AS_NODE if set (otherwise claude binary may not work properly)
          delete env.ELECTRON_RUN_AS_NODE;

          const args = ['auth', 'login'];
          const child = spawn(claudePath, args, {
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            // On Windows, .cmd files need shell: true
            shell: isWindows() && claudePath.endsWith('.cmd'),
          });

          let stdout = '';
          let stderr = '';

          child.stdout?.on('data', (data: Buffer) => {
            const text = data.toString();
            stdout += text;
            console.warn('[Claude Code] auth login stdout:', text.trim());

            // Send progress updates based on output
            if (text.toLowerCase().includes('browser') || text.toLowerCase().includes('open')) {
              sender.send(IPC_CHANNELS.CLAUDE_AUTH_LOGIN_PROGRESS, {
                status: 'waiting',
                message: 'Waiting for authorization in browser...'
              });
            }
          });

          child.stderr?.on('data', (data: Buffer) => {
            const text = data.toString();
            stderr += text;
            console.warn('[Claude Code] auth login stderr:', text.trim());
          });

          // Timeout after 5 minutes
          const timeout = setTimeout(() => {
            child.kill();
            sender.send(IPC_CHANNELS.CLAUDE_AUTH_LOGIN_PROGRESS, {
              status: 'error',
              message: 'Authentication timed out'
            });
            resolve({
              success: false,
              error: 'Authentication timed out after 5 minutes'
            });
          }, 5 * 60 * 1000);

          child.on('close', async (code) => {
            clearTimeout(timeout);

            if (code === 0) {
              // Verify authentication
              const result = checkProfileAuthentication(configDir);
              console.warn('[Claude Code] Auth subprocess result:', result);

              if (result.authenticated) {
                // Update profile metadata (same logic as VERIFY_AUTH handler)
                profile.isAuthenticated = true;
                if (result.email) {
                  profile.email = result.email;
                }
                updateProfileSubscriptionMetadata(profile, expandedConfigDir);
                profileManager.saveProfile(profile);
                clearKeychainCache(expandedConfigDir);
                const usageMonitor = getUsageMonitor();
                usageMonitor.clearProfileUsageCache(profileId);
                usageMonitor.checkNow();
                console.warn('[Claude Code] Triggered immediate usage check after re-authentication:', profileId);

                // Clean up backup
                if (existsSync(claudeJsonBakPath)) {
                  try { await unlink(claudeJsonBakPath); } catch { /* non-fatal */ }
                }

                sender.send(IPC_CHANNELS.CLAUDE_AUTH_LOGIN_PROGRESS, {
                  status: 'success',
                  message: result.email || 'Authenticated'
                });

                resolve({
                  success: true,
                  data: { authenticated: true, email: result.email }
                });
              } else {
                // Process exited 0 but no credentials found
                sender.send(IPC_CHANNELS.CLAUDE_AUTH_LOGIN_PROGRESS, {
                  status: 'error',
                  message: 'Authentication completed but credentials not found'
                });
                resolve({
                  success: false,
                  error: 'Authentication completed but credentials were not saved'
                });
              }
            } else {
              // Restore backup on failure
              if (existsSync(claudeJsonBakPath)) {
                try {
                  if (existsSync(claudeJsonPath)) await unlink(claudeJsonPath);
                  await rename(claudeJsonBakPath, claudeJsonPath);
                } catch { /* non-fatal */ }
              }

              const errorMsg = stderr.trim() || `Process exited with code ${code}`;
              sender.send(IPC_CHANNELS.CLAUDE_AUTH_LOGIN_PROGRESS, {
                status: 'error',
                message: errorMsg
              });
              resolve({
                success: false,
                error: `Authentication failed: ${errorMsg}`
              });
            }
          });

          child.on('error', (err) => {
            clearTimeout(timeout);
            sender.send(IPC_CHANNELS.CLAUDE_AUTH_LOGIN_PROGRESS, {
              status: 'error',
              message: err.message
            });
            resolve({
              success: false,
              error: `Failed to start authentication: ${err.message}`
            });
          });
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error('[Claude Code] Auth login subprocess failed:', errorMsg, error);
        return { success: false, error: `Authentication failed: ${errorMsg}` };
      }
    }
  );

  console.warn('[IPC] Claude Code handlers registered');
}
