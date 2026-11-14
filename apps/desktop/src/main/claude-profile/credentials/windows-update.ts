/**
 * Windows credential update (Credential Manager plus file-based fallback).
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { userInfo } from 'os';
import { dirname } from 'path';
import { credentialCache } from './cache';
import { getWindowsCredentialTarget, isValidCredentialsPath, isValidTargetName } from './naming';
import { WINDOWS_CREDMAN_TIMEOUT_MS } from './types';
import type { UpdateCredentialsResult } from './types';
import {
  encodeBase64ForPowerShell,
  escapePowerShellString,
  findPowerShellPath,
  getFullCredentialsFromWindowsCredentialManager,
  getFullCredentialsFromWindowsFile,
  getWindowsCredentialsPath,
} from './windows-read';

/**
 * Clear cached credentials after an update (mirrors clearKeychainCache for Windows keys).
 */
function clearWindowsCredentialCache(configDir?: string): void {
  if (configDir) {
    credentialCache.delete(`windows:${getWindowsCredentialTarget(configDir)}`);
    credentialCache.delete(`windows-file:${getWindowsCredentialsPath(configDir)}`);
  } else {
    credentialCache.clear();
  }
}

/**
 * Update credentials in Windows Credential Manager with new tokens
 */
function updateWindowsCredentialManagerCredentials(
  configDir: string | undefined,
  credentials: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes?: string[];
  }
): UpdateCredentialsResult {
  const targetName = getWindowsCredentialTarget(configDir);
  const isDebug = process.env.DEBUG === 'true';

  // Defense-in-depth: Validate target name format
  if (!isValidTargetName(targetName)) {
    return { success: false, error: 'Invalid credential target name format' };
  }

  // Find PowerShell executable
  const psPath = findPowerShellPath();
  if (!psPath) {
    return { success: false, error: 'PowerShell not found' };
  }

  try {
    // Read existing credentials to preserve email, subscriptionType, and rateLimitTier
    const existing = getFullCredentialsFromWindowsCredentialManager(configDir);

    // Build new credential JSON with all fields
    // IMPORTANT: Preserve subscriptionType and rateLimitTier from existing credentials
    const newCredentialData = {
      claudeAiOauth: {
        accessToken: credentials.accessToken,
        refreshToken: credentials.refreshToken,
        expiresAt: credentials.expiresAt,
        scopes: credentials.scopes || existing.scopes || [],
        email: existing.email || undefined,
        emailAddress: existing.email || undefined,
        subscriptionType: existing.subscriptionType || undefined,
        rateLimitTier: existing.rateLimitTier || undefined
      },
      email: existing.email || undefined
    };

    const credentialsJson = JSON.stringify(newCredentialData);
    // Use base64 encoding for maximum security - prevents all injection attacks
    const base64Json = encodeBase64ForPowerShell(credentialsJson);

    // PowerShell script to write to Credential Manager
    //
    // NOTE: This CREDENTIAL struct uses string types for TargetName, Comment, etc.
    // because CredWrite accepts data FROM us, and the .NET marshaler can automatically
    // convert string fields to the appropriate Unicode pointers when CALLING Windows APIs.
    // This differs from the CredRead struct (see getCredentialsFromWindowsCredentialManager)
    // which must use IntPtr because we're RECEIVING data from Windows and need to manually
    // marshal the strings from Windows-allocated memory.
    const psScript = `
      $ErrorActionPreference = 'Stop'

      # Use CredWrite from advapi32.dll to write generic credentials
      # This struct uses string types (auto-marshaled) unlike CredRead which needs IntPtr.
      $sig = @'
      [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
      public struct CREDENTIAL {
        public int Flags;
        public int Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
      }

      [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
      public static extern bool CredWrite(ref CREDENTIAL credential, int flags);
'@
      Add-Type -MemberDefinition $sig -Namespace Win32 -Name Credential

      # Decode base64 JSON (more secure than string escaping)
      $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${base64Json}'))
      $jsonBytes = [System.Text.Encoding]::Unicode.GetBytes($json)
      $jsonPtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($jsonBytes.Length)
      [System.Runtime.InteropServices.Marshal]::Copy($jsonBytes, 0, $jsonPtr, $jsonBytes.Length)

      try {
        $cred = New-Object Win32.Credential+CREDENTIAL
        $cred.Type = 1  # CRED_TYPE_GENERIC
        $cred.TargetName = "${escapePowerShellString(targetName)}"
        $cred.CredentialBlob = $jsonPtr
        $cred.CredentialBlobSize = $jsonBytes.Length
        $cred.Persist = 2  # CRED_PERSIST_LOCAL_MACHINE
        $cred.UserName = "claude-ai-oauth"

        $success = [Win32.Credential]::CredWrite([ref]$cred, 0)
        if (-not $success) {
          throw "CredWrite failed"
        }
        Write-Output "SUCCESS"
      } finally {
        [System.Runtime.InteropServices.Marshal]::FreeHGlobal($jsonPtr)
      }
    `;

    const result = execFileSync(
      psPath,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
      {
        encoding: 'utf-8',
        timeout: WINDOWS_CREDMAN_TIMEOUT_MS,
        windowsHide: true,
      }
    );

    if (result.trim() !== 'SUCCESS') {
      return { success: false, error: 'Credential Manager update failed' };
    }

    if (isDebug) {
      console.warn('[CredentialUtils:Windows:Update] Successfully updated Credential Manager for target:', targetName);
    }

    // Clear cached credentials to ensure fresh values are read
    clearWindowsCredentialCache(configDir);

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[CredentialUtils:Windows:Update] Failed to update Credential Manager:', errorMessage);
    return { success: false, error: `Credential Manager update failed: ${errorMessage}` };
  }
}

/**
 * Restrict Windows file permissions to current user only using icacls.
 * This is a best-effort operation - if it fails, we log a warning but don't fail the overall operation.
 *
 * @param filePath - Path to the file to secure
 */
function restrictWindowsFilePermissions(filePath: string): void {
  const isDebug = process.env.DEBUG === 'true';

  try {
    // Use icacls to:
    // 1. Disable inheritance and remove all inherited permissions (/inheritance:r)
    // 2. Grant full control to the current user only (/grant:r %USERNAME%:F)
    // This mimics Unix 0600 permissions (owner read/write only)
    const username = userInfo().username;

    // First, disable inheritance and remove inherited permissions
    execFileSync('icacls', [filePath, '/inheritance:r'], {
      windowsHide: true,
      timeout: 5000,
    });

    // Then grant full control to current user only
    execFileSync('icacls', [filePath, '/grant:r', `${username}:F`], {
      windowsHide: true,
      timeout: 5000,
    });

    if (isDebug) {
      console.warn('[CredentialUtils:Windows] Set restrictive permissions on:', filePath);
    }
  } catch (error) {
    // Non-fatal: log warning but don't fail the operation
    // The file is still protected by the user's home directory permissions
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn('[CredentialUtils:Windows] Could not set restrictive file permissions:', errorMessage);
  }
}

/**
 * Update credentials in Windows .credentials.json file with new tokens (fallback).
 *
 * This is the fallback method for Windows when Credential Manager is unavailable.
 * Claude CLI on Windows primarily uses file-based storage (.credentials.json),
 * so this fallback ensures credentials are persisted even if Credential Manager fails.
 *
 * Security: We use icacls to restrict file permissions to the current user only,
 * mimicking Unix 0600 permissions. This prevents other users on multi-user systems
 * from reading the OAuth tokens.
 *
 * @param configDir - Config directory for the profile (undefined for default profile)
 * @param credentials - New credentials to store
 * @returns Result indicating success or failure
 */
function updateWindowsFileCredentials(
  configDir: string | undefined,
  credentials: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes?: string[];
  }
): UpdateCredentialsResult {
  const credentialsPath = getWindowsCredentialsPath(configDir);
  const isDebug = process.env.DEBUG === 'true';

  // Defense-in-depth: Validate credentials path
  if (!isValidCredentialsPath(credentialsPath)) {
    return { success: false, error: 'Invalid credentials path' };
  }

  try {
    // Read existing credentials to preserve email and other fields
    const existing = getFullCredentialsFromWindowsFile(configDir);

    // Build new credential JSON with all fields
    // CodeQL: network data validated before write - validate token fields are expected types before writing
    const newCredentialData = {
      claudeAiOauth: {
        accessToken: typeof credentials.accessToken === 'string' ? credentials.accessToken : '',
        refreshToken: typeof credentials.refreshToken === 'string' ? credentials.refreshToken : '',
        expiresAt: typeof credentials.expiresAt === 'number' ? credentials.expiresAt : 0,
        scopes: Array.isArray(credentials.scopes) ? credentials.scopes.filter(s => typeof s === 'string') : (existing.scopes || []),
        email: existing.email || undefined,
        emailAddress: existing.email || undefined,
        subscriptionType: existing.subscriptionType || undefined,
        rateLimitTier: existing.rateLimitTier || undefined
      },
      email: existing.email || undefined
    };

    const credentialsJson = JSON.stringify(newCredentialData, null, 2);

    // Ensure directory exists with secure permissions
    const dirPath = dirname(credentialsPath);
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
      // Restrict directory permissions to current user only (mimics Unix 0700)
      restrictWindowsFilePermissions(dirPath);
    }

    // Atomic file write: write to temp file, set permissions, then rename.
    // This prevents a race condition where the file briefly exists with default permissions.
    const tempPath = `${credentialsPath}.${Date.now()}.tmp`;
    try {
      // Write to temp file
      // lgtm[js/http-to-file-access] - credentialsPath is from controlled configDir
      writeFileSync(tempPath, credentialsJson, { encoding: 'utf-8' });

      // Restrict temp file permissions to current user only (mimics Unix 0600)
      restrictWindowsFilePermissions(tempPath);

      // Atomic rename (on same filesystem, this is atomic on Windows)
      renameSync(tempPath, credentialsPath);
    } catch (writeError) {
      // Clean up temp file on error
      try {
        if (existsSync(tempPath)) {
          unlinkSync(tempPath);
        }
      } catch {
        // Ignore cleanup errors
      }
      throw writeError;
    }

    if (isDebug) {
      console.warn('[CredentialUtils:Windows:Update] Successfully updated credentials file:', credentialsPath);
    }

    // Clear cached credentials to ensure fresh values are read
    clearWindowsCredentialCache(configDir);

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[CredentialUtils:Windows:Update] Failed to update credentials file:', errorMessage);
    return { success: false, error: `File update failed: ${errorMessage}` };
  }
}

/**
 * Update credentials in Windows - writes to file FIRST (primary storage), then Credential Manager.
 *
 * Claude CLI on Windows primarily uses file-based storage (.credentials.json).
 * We write to file first to ensure Claude CLI always has the latest tokens,
 * then update Credential Manager for forward compatibility.
 *
 * IMPORTANT: The write order matters! If we wrote to Credential Manager first and file
 * write failed, Claude CLI would read stale tokens from the file while Credential Manager
 * has the new tokens - an inconsistent state. By writing to file first, we ensure the
 * primary storage is always up-to-date.
 *
 * @param configDir - Config directory for the profile (undefined for default profile)
 * @param credentials - New credentials to store
 * @returns Result indicating success or failure
 */
export function updateWindowsCredentials(
  configDir: string | undefined,
  credentials: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes?: string[];
  }
): UpdateCredentialsResult {
  const isDebug = process.env.DEBUG === 'true';

  // Write to file FIRST - this is what Claude CLI reads on Windows
  const fileResult = updateWindowsFileCredentials(configDir, credentials);
  if (!fileResult.success) {
    // File write failed - don't proceed with Credential Manager to avoid inconsistent state
    console.error('[CredentialUtils:Windows:Update] File update failed:', fileResult.error);
    return fileResult;
  }

  // File write succeeded - now update Credential Manager for forward compatibility
  const psPath = findPowerShellPath();
  if (psPath) {
    const credManagerResult = updateWindowsCredentialManagerCredentials(configDir, credentials);
    if (!credManagerResult.success) {
      // Credential Manager failed but file succeeded - this is acceptable
      // Claude CLI will use the file, which has the latest tokens
      if (isDebug) {
        console.warn('[CredentialUtils:Windows:Update] Credential Manager update failed (file update succeeded):', credManagerResult.error);
      }
    }
  }

  // Return success since file (primary storage) was updated successfully
  return { success: true };
}
