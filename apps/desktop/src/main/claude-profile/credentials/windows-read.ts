/**
 * Windows credential reading: file-based storage and Credential Manager
 * (via PowerShell). Prefers the file when both sources have tokens.
 */

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { CACHE_TTL_MS, ERROR_CACHE_TTL_MS, credentialCache } from './cache';
import { getCredentialsFromFile, getFullCredentialsFromFile } from './file-credentials';
import { getWindowsCredentialTarget, isValidTargetName, isValidTokenFormat } from './naming';
import {
  extractCredentials,
  extractFullCredentials,
  getTokenFingerprint,
  parseCredentialJson,
} from './parsing';
import { WINDOWS_CREDMAN_TIMEOUT_MS, isVerbose } from './types';
import type { FullOAuthCredentials, PlatformCredentials } from './types';

/**
 * Escape a string for safe interpolation into PowerShell double-quoted strings.
 * Escapes all PowerShell special characters to prevent injection attacks.
 *
 * @param str - The string to escape
 * @returns The escaped string safe for PowerShell interpolation
 */
export function escapePowerShellString(str: string): string {
  return str
    .replace(/`/g, '``')   // Backtick is PowerShell's escape character - must be escaped first
    .replace(/\$/g, '`$')  // Dollar sign triggers variable expansion
    .replace(/"/g, '`"');  // Double quotes end the string
}

/**
 * Encode a string to base64 for safe passing to PowerShell.
 * This is the most secure way to pass arbitrary data to PowerShell scripts.
 *
 * @param str - The string to encode
 * @returns Base64-encoded string
 */
export function encodeBase64ForPowerShell(str: string): string {
  return Buffer.from(str, 'utf-8').toString('base64');
}


/**
 * Retrieve credentials from Windows Credential Manager using PowerShell
 *
 * Windows Credential Manager stores credentials with:
 * - Target Name: "Claude Code-credentials" or "Claude Code-credentials-{hash}"
 * - Type: Generic credential
 * - Password field contains JSON with { claudeAiOauth: { accessToken, email } }
 */
function getCredentialsFromWindowsCredentialManager(configDir?: string, forceRefresh = false): PlatformCredentials {
  const targetName = getWindowsCredentialTarget(configDir);
  const cacheKey = `windows:${targetName}`;
  const isDebug = process.env.DEBUG === 'true';
  const now = Date.now();

  // Return cached credentials if available and fresh
  const cached = credentialCache.get(cacheKey);
  if (!forceRefresh && cached) {
    const ttl = cached.credentials.error ? ERROR_CACHE_TTL_MS : CACHE_TTL_MS;
    if ((now - cached.timestamp) < ttl) {
      if (isVerbose) {
        const cacheAge = now - cached.timestamp;
        console.warn('[CredentialUtils:Windows:CACHE] Returning cached credentials:', {
          targetName,
          hasToken: !!cached.credentials.token,
          tokenFingerprint: getTokenFingerprint(cached.credentials.token),
          cacheAge: Math.round(cacheAge / 1000) + 's'
        });
      }
      return cached.credentials;
    }
  }

  // Defense-in-depth: Validate target name format before using in PowerShell
  if (!isValidTargetName(targetName)) {
    const invalidResult = { token: null, email: null, error: 'Invalid credential target name format' };
    credentialCache.set(cacheKey, { credentials: invalidResult, timestamp: now });
    if (isDebug) {
      console.warn('[CredentialUtils:Windows] Invalid target name rejected:', { targetName });
    }
    return invalidResult;
  }

  // Find PowerShell executable
  const psPath = findPowerShellPath();
  if (!psPath) {
    const notFoundResult = { token: null, email: null, error: 'PowerShell not found' };
    credentialCache.set(cacheKey, { credentials: notFoundResult, timestamp: now });
    return notFoundResult;
  }

  try {
    // PowerShell script to read from Credential Manager
    // Uses the Windows Credential Manager API via .NET
    // NOTE: The CREDENTIAL struct must use IntPtr for string fields (blittable requirement)
    // and strings must be manually marshaled after PtrToStructure
    //
    // NOTE: This CREDENTIAL struct uses IntPtr for string fields (TargetName, Comment, etc.)
    // because CredRead returns a pointer to Windows-allocated memory. We must use a "blittable"
    // struct layout where strings are IntPtr, then manually marshal strings via PtrToStringUni.
    // This differs from the CredWrite struct (see updateWindowsCredentialManagerCredentials)
    // which uses string types because the .NET marshaler can automatically convert strings
    // to pointers when CALLING Windows APIs (but not when RECEIVING data from them).
    const psScript = `
      $ErrorActionPreference = 'Stop'

      # Define the CREDENTIAL struct with IntPtr for string fields (required for CredRead marshaling)
      # See comment above for why this differs from the CredWrite struct definition.
      Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public IntPtr TargetName;
    public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public IntPtr TargetAlias;
    public IntPtr UserName;
}
'@

      # Import CredRead and CredFree from advapi32.dll
      Add-Type -MemberDefinition @'
[DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern bool CredRead(string target, uint type, uint reservedFlag, out IntPtr credentialPtr);

[DllImport("advapi32.dll", SetLastError = true)]
public static extern bool CredFree(IntPtr cred);
'@ -Namespace Win32 -Name CredApi

      $credPtr = [IntPtr]::Zero
      # CRED_TYPE_GENERIC = 1
      $success = [Win32.CredApi]::CredRead("${escapePowerShellString(targetName)}", 1, 0, [ref]$credPtr)

      if ($success) {
        try {
          # Marshal the pointer to our CREDENTIAL struct
          $cred = [Runtime.InteropServices.Marshal]::PtrToStructure($credPtr, [Type][CREDENTIAL])

          # Read the credential blob (password field) - contains the JSON
          $blobSize = $cred.CredentialBlobSize
          if ($blobSize -gt 0) {
            $blob = [byte[]]::new($blobSize)
            [Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $blob, 0, $blobSize)
            $password = [System.Text.Encoding]::Unicode.GetString($blob)
            Write-Output $password
          }
        } finally {
          [Win32.CredApi]::CredFree($credPtr) | Out-Null
        }
      } else {
        # Credential not found - this is expected if user hasn't authenticated
        Write-Output ""
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

    const credentialsJson = result.trim() || null;

    // Parse and validate using shared helper
    const { token, email } = parseCredentialJson(
      credentialsJson,
      `Windows:${targetName}`,
      extractCredentials
    );

    // Validate token format if present
    if (token && !isValidTokenFormat(token)) {
      console.warn('[CredentialUtils:Windows] Invalid token format for target:', targetName);
      const result = { token: null, email };
      credentialCache.set(cacheKey, { credentials: result, timestamp: now });
      return result;
    }

    const credentials = { token, email };
    credentialCache.set(cacheKey, { credentials, timestamp: now });

    if (isVerbose) {
      console.warn('[CredentialUtils:Windows] Retrieved credentials from Credential Manager for target:', targetName, {
        hasToken: !!token,
        hasEmail: !!email,
        tokenFingerprint: getTokenFingerprint(token),
        forceRefresh
      });
    }
    return credentials;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn('[CredentialUtils:Windows] Credential Manager access failed for target:', targetName, errorMessage);
    const errorResult = { token: null, email: null, error: `Credential Manager access failed: ${errorMessage}` };
    credentialCache.set(cacheKey, { credentials: errorResult, timestamp: now });
    return errorResult;
  }
}

/**
 * Find PowerShell executable path on Windows
 */
export function findPowerShellPath(): string | null {
  // Prefer PowerShell 7+ (pwsh) over Windows PowerShell
  const candidatePaths = [
    join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    join(homedir(), 'AppData', 'Local', 'Microsoft', 'WindowsApps', 'pwsh.exe'),
    join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ];

  for (const candidate of candidatePaths) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

// =============================================================================
// Windows Credentials File Implementation (Fallback)
// =============================================================================

/**
 * Get the credentials file path for Windows
 * Claude CLI on Windows stores credentials in .credentials.json files, not Windows Credential Manager
 */
export function getWindowsCredentialsPath(configDir?: string): string {
  const baseDir = configDir || join(homedir(), '.claude');
  return join(baseDir, '.credentials.json');
}

/**
 * Retrieve credentials from Windows .credentials.json file
 * This is the primary storage mechanism used by Claude CLI on Windows
 */
function getCredentialsFromWindowsFile(configDir?: string, forceRefresh = false): PlatformCredentials {
  const credentialsPath = getWindowsCredentialsPath(configDir);
  const cacheKey = `windows-file:${credentialsPath}`;
  return getCredentialsFromFile(credentialsPath, cacheKey, 'Windows:File', forceRefresh);
}

/**
 * Retrieve credentials from Windows - checks both file and Credential Manager, uses the most recent valid token.
 * Claude CLI on Windows can store credentials in either location, and they may get out of sync.
 * We compare both sources and return the one with the most recent/valid token.
 */
export function getCredentialsFromWindows(configDir?: string, forceRefresh = false): PlatformCredentials {
  const isDebug = process.env.DEBUG === 'true';

  // Get credentials from both sources
  const fileResult = getCredentialsFromWindowsFile(configDir, forceRefresh);
  const credManagerResult = getCredentialsFromWindowsCredentialManager(configDir, forceRefresh);

  // If only one has a token, use that one
  if (fileResult.token && !credManagerResult.token) {
    if (isDebug) {
      console.warn('[CredentialUtils:Windows] Using file credentials (Credential Manager empty)');
    }
    return fileResult;
  }
  if (credManagerResult.token && !fileResult.token) {
    if (isDebug) {
      console.warn('[CredentialUtils:Windows] Using Credential Manager credentials (file empty)');
    }
    return credManagerResult;
  }

  // If neither has a token, return file result (which has the appropriate error)
  if (!fileResult.token && !credManagerResult.token) {
    return fileResult;
  }

  // Both have tokens - prefer file since Claude CLI writes there after login
  if (isDebug) {
    console.warn('[CredentialUtils:Windows] Both sources have tokens, preferring file (Claude CLI primary storage)');
  }
  return fileResult;
}

/**
 * Retrieve full credentials (including refresh token) from Windows Credential Manager
 */
export function getFullCredentialsFromWindowsCredentialManager(configDir?: string): FullOAuthCredentials {
  const targetName = getWindowsCredentialTarget(configDir);
  const isDebug = process.env.DEBUG === 'true';

  // Defense-in-depth: Validate target name format before using in PowerShell
  if (!isValidTargetName(targetName)) {
    const invalidResult = { token: null, email: null, refreshToken: null, expiresAt: null, scopes: null, subscriptionType: null, rateLimitTier: null, error: 'Invalid credential target name format' };
    if (isDebug) {
      console.warn('[CredentialUtils:Windows:Full] Invalid target name rejected:', { targetName });
    }
    return invalidResult;
  }

  // Find PowerShell executable
  const psPath = findPowerShellPath();
  if (!psPath) {
    return { token: null, email: null, refreshToken: null, expiresAt: null, scopes: null, subscriptionType: null, rateLimitTier: null, error: 'PowerShell not found' };
  }

  try {
    // PowerShell script to read from Credential Manager (same as basic credentials)
    // NOTE: The CREDENTIAL struct must use IntPtr for string fields (blittable requirement)
    const psScript = `
      $ErrorActionPreference = 'Stop'

      # Define the CREDENTIAL struct with IntPtr for string fields (required for marshaling)
      Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public IntPtr TargetName;
    public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public IntPtr TargetAlias;
    public IntPtr UserName;
}
'@

      # Import CredRead and CredFree from advapi32.dll
      Add-Type -MemberDefinition @'
[DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern bool CredRead(string target, uint type, uint reservedFlag, out IntPtr credentialPtr);

[DllImport("advapi32.dll", SetLastError = true)]
public static extern bool CredFree(IntPtr cred);
'@ -Namespace Win32 -Name CredApi

      $credPtr = [IntPtr]::Zero
      # CRED_TYPE_GENERIC = 1
      $success = [Win32.CredApi]::CredRead("${escapePowerShellString(targetName)}", 1, 0, [ref]$credPtr)

      if ($success) {
        try {
          # Marshal the pointer to our CREDENTIAL struct
          $cred = [Runtime.InteropServices.Marshal]::PtrToStructure($credPtr, [Type][CREDENTIAL])

          # Read the credential blob (password field) - contains the JSON
          $blobSize = $cred.CredentialBlobSize
          if ($blobSize -gt 0) {
            $blob = [byte[]]::new($blobSize)
            [Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $blob, 0, $blobSize)
            $password = [System.Text.Encoding]::Unicode.GetString($blob)
            Write-Output $password
          }
        } finally {
          [Win32.CredApi]::CredFree($credPtr) | Out-Null
        }
      } else {
        # Credential not found - this is expected if user hasn't authenticated
        Write-Output ""
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

    const credentialsJson = result.trim() || null;

    // Parse and validate using shared helper
    const { token, email, refreshToken, expiresAt, scopes, subscriptionType, rateLimitTier } = parseCredentialJson(
      credentialsJson,
      `Windows:Full:${targetName}`,
      extractFullCredentials
    );

    // Validate token format if present
    if (token && !isValidTokenFormat(token)) {
      console.warn('[CredentialUtils:Windows:Full] Invalid token format for target:', targetName);
      return { token: null, email, refreshToken, expiresAt, scopes, subscriptionType, rateLimitTier };
    }

    if (isVerbose) {
      console.warn('[CredentialUtils:Windows:Full] Retrieved full credentials from Credential Manager for target:', targetName, {
        hasToken: !!token,
        hasEmail: !!email,
        hasRefreshToken: !!refreshToken,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        tokenFingerprint: getTokenFingerprint(token),
        subscriptionType,
        rateLimitTier
      });
    }
    return { token, email, refreshToken, expiresAt, scopes, subscriptionType, rateLimitTier };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn('[CredentialUtils:Windows:Full] Credential Manager access failed for target:', targetName, errorMessage);
    return { token: null, email: null, refreshToken: null, expiresAt: null, scopes: null, subscriptionType: null, rateLimitTier: null, error: `Credential Manager access failed: ${errorMessage}` };
  }
}

/**
 * Retrieve full credentials (including refresh token) from Windows .credentials.json file
 * This is the primary storage mechanism used by Claude CLI on Windows
 */
export function getFullCredentialsFromWindowsFile(configDir?: string): FullOAuthCredentials {
  const credentialsPath = getWindowsCredentialsPath(configDir);
  return getFullCredentialsFromFile(credentialsPath, 'Windows:File:Full');
}

/**
 * Retrieve full credentials from Windows - checks both file and Credential Manager, uses the most recent valid token.
 * Claude CLI on Windows can store credentials in either location, and they may get out of sync.
 * We compare both sources and return the one with the later expiry time (most recently refreshed).
 */
export function getFullCredentialsFromWindows(configDir?: string): FullOAuthCredentials {
  const isDebug = process.env.DEBUG === 'true';

  // Get credentials from both sources
  const fileResult = getFullCredentialsFromWindowsFile(configDir);
  const credManagerResult = getFullCredentialsFromWindowsCredentialManager(configDir);

  // If only one has a token, use that one
  if (fileResult.token && !credManagerResult.token) {
    if (isDebug) {
      console.warn('[CredentialUtils:Windows:Full] Using file credentials (Credential Manager empty)');
    }
    return fileResult;
  }
  if (credManagerResult.token && !fileResult.token) {
    if (isDebug) {
      console.warn('[CredentialUtils:Windows:Full] Using Credential Manager credentials (file empty)');
    }
    return credManagerResult;
  }

  // If neither has a token, return file result (which has the appropriate error)
  if (!fileResult.token && !credManagerResult.token) {
    return fileResult;
  }

  // Both have tokens - prefer file since Claude CLI writes there after login
  // This is consistent with getCredentialsFromWindows() which also prefers file.
  // Using file as primary ensures consistency: the same token is returned whether
  // calling getCredentialsFromKeychain() or getFullCredentialsFromKeychain().
  if (isDebug) {
    console.warn('[CredentialUtils:Windows:Full] Both sources have tokens, preferring file (Claude CLI primary storage)');
  }
  return fileResult;
}
