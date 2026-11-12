/**
 * CLI Tool Manager
 *
 * Centralized management for CLI tools (Python, Git, GitHub CLI, GitLab CLI,
 * Claude CLI) used throughout the application: detection, validation and
 * session caching (no TTL; the cache lasts until app restart or a settings change).
 *
 * Every per-tool fact (candidate locations, their order, version parsing,
 * minimum version, messages) is described once, in cli-tools/specs.ts. The
 * generic sync and async detectors live in cli-tools/detect.ts. This file only
 * holds the cache, the user configuration and the public API.
 */

import os from 'os';
import { app } from 'electron';
import { getCurrentOS, isWindows } from './platform';
import type { ToolDetectionResult } from '../shared/types';
import {
  detectAsync,
  detectSync,
  isWrongPlatformPath,
  validateClaudeAsync,
} from './cli-tools/detect';
import { TOOL_SPECS } from './cli-tools/specs';
import type { CLITool, DetectionContext, ToolValidation } from './cli-tools/types';

export type { CLITool, ToolValidation };
export { validateClaudeAsync };
export { getClaudeDetectionPaths } from './cli-tools/specs';
export { sortNvmVersionDirs, buildClaudeDetectionResult } from './cli-tools/detect';
export type {
  ExecFileSyncOptionsWithVerbatim,
  ExecFileAsyncOptionsWithVerbatim,
} from './cli-tools/run-version';

/**
 * User configuration for CLI tool paths
 * Maps to settings stored in settings.json
 */
export interface ToolConfig {
  pythonPath?: string;
  gitPath?: string;
  githubCLIPath?: string;
  gitlabCLIPath?: string;
  claudePath?: string;
}

/**
 * Cache entry for detected tool path
 * No timestamp - cache persists for entire app session
 */
interface CacheEntry {
  path: string;
  version?: string;
  source: string;
}

/** Environment facts detection depends on, read at call time (never at module load) */
function buildContext(): DetectionContext {
  return {
    os: getCurrentOS(),
    homeDir: os.homedir(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  };
}

const unknownTool = (tool: string): ToolDetectionResult => ({
  found: false,
  source: 'fallback',
  message: `Unknown tool: ${tool}`,
});

/**
 * Centralized CLI Tool Manager
 *
 * Singleton class that manages detection, validation, and caching of CLI tool
 * paths. Supports user configuration overrides and intelligent auto-detection.
 *
 * Usage:
 *   import { getToolPath, configureTools } from './cli-tool-manager';
 *
 *   // Configure with user settings (optional)
 *   configureTools({ pythonPath: '/custom/python3', gitPath: '/custom/git' });
 *
 *   // Get tool path (auto-detects if not configured)
 *   const pythonPath = getToolPath('python');
 *   const gitPath = getToolPath('git');
 */
class CLIToolManager {
  private cache: Map<CLITool, CacheEntry> = new Map();
  private userConfig: ToolConfig = {};

  /**
   * Configure the tool manager with user settings
   *
   * Clears the cache to force re-detection with new configuration.
   * Call this when user changes CLI tool paths in Settings.
   *
   * @param config - User configuration for CLI tool paths
   */
  configure(config: ToolConfig): void {
    this.userConfig = config;
    this.cache.clear();
    console.warn('[CLI Tools] Configuration updated, cache cleared');
  }

  /**
   * Get the path for a specific CLI tool
   *
   * Uses cached path if available, otherwise detects and caches.
   * Cache persists for entire app session (no expiration).
   *
   * @param tool - The CLI tool to get the path for
   * @returns The resolved path to the tool executable
   */
  getToolPath(tool: CLITool): string {
    // Check cache first
    const cached = this.cache.get(tool);
    if (cached) {
      console.debug(
        `[CLI Tools] Using cached ${tool}: ${cached.path} (${cached.source})`
      );
      return cached.path;
    }

    // Detect and cache
    const result = this.detectToolPath(tool);
    if (result.found && result.path) {
      this.cache.set(tool, {
        path: result.path,
        version: result.version,
        source: result.source,
      });
      console.warn(`[CLI Tools] Detected ${tool}: ${result.path} (${result.source})`);
      return result.path;
    }

    // Fallback to tool name (let system PATH resolve it)
    console.warn(`[CLI Tools] ${tool} not found, using fallback: "${tool}"`);
    return tool;
  }

  /**
   * Get Claude CLI path for SDK usage
   *
   * Returns null when a .cmd file is detected on Windows, so the SDK
   * can use its bundled claude.exe instead. The SDK's bundled CLI is
   * a proper Windows executable that can be spawned by anyio.open_process().
   *
   * @returns Claude CLI path, or null if SDK should use bundled CLI
   */
  getClaudeCliPathForSdk(): string | null {
    const claudePath = this.getToolPath('claude');

    // On Windows, .cmd files cannot be executed by anyio.open_process() / asyncio.create_subprocess_exec().
    // Return null so the Claude Agent SDK uses its bundled claude.exe instead.
    if (isWindows() && claudePath.toLowerCase().endsWith('.cmd')) {
      console.warn(
        `[CLI Tools] Claude CLI is .cmd file, returning null so SDK uses bundled CLI: ${claudePath}`
      );
      return null;
    }

    return claudePath;
  }

  /** Detect a tool synchronously from its TOOL_SPECS entry */
  private detectToolPath(tool: CLITool): ToolDetectionResult {
    const spec = TOOL_SPECS[tool];
    if (!spec) return unknownTool(tool);
    return detectSync(spec, this.userConfig[spec.configKey], buildContext());
  }

  /** Detect a tool asynchronously from its TOOL_SPECS entry */
  private async detectToolPathAsync(tool: CLITool): Promise<ToolDetectionResult> {
    const spec = TOOL_SPECS[tool];
    if (!spec) return unknownTool(tool);
    return detectAsync(spec, this.userConfig[spec.configKey], buildContext());
  }

  /**
   * Get the path for a CLI tool asynchronously (non-blocking)
   *
   * Uses cached path if available, otherwise detects asynchronously.
   * Safe to call from Electron main process without blocking.
   *
   * @param tool - The CLI tool to get the path for
   * @returns Promise resolving to the tool path
   */
  async getToolPathAsync(tool: CLITool): Promise<string> {
    // Check cache first (instant return if cached)
    const cached = this.cache.get(tool);
    if (cached) {
      console.debug(
        `[CLI Tools] Using cached ${tool}: ${cached.path} (${cached.source})`
      );
      return cached.path;
    }

    // Detect asynchronously
    const result = await this.detectToolPathAsync(tool);
    if (result.found && result.path) {
      this.cache.set(tool, {
        path: result.path,
        version: result.version,
        source: result.source,
      });
      console.warn(`[CLI Tools] Detected ${tool}: ${result.path} (${result.source})`);
      return result.path;
    }

    // Fallback to tool name (let system PATH resolve it)
    console.warn(`[CLI Tools] ${tool} not found, using fallback: "${tool}"`);
    return tool;
  }

  /**
   * Get Claude CLI path for SDK usage asynchronously (non-blocking)
   *
   * Returns null when a .cmd file is detected on Windows, so the SDK
   * can use its bundled claude.exe instead.
   *
   * @returns Promise resolving to Claude CLI path, or null if SDK should use bundled CLI
   */
  async getClaudeCliPathForSdkAsync(): Promise<string | null> {
    const claudePath = await this.getToolPathAsync('claude');

    // On Windows, .cmd files cannot be executed by anyio.open_process() / asyncio.create_subprocess_exec().
    // Return null so the Claude Agent SDK uses its bundled claude.exe instead.
    if (isWindows() && claudePath.toLowerCase().endsWith('.cmd')) {
      console.warn(
        `[CLI Tools] Claude CLI is .cmd file, returning null so SDK uses bundled CLI: ${claudePath}`
      );
      return null;
    }

    return claudePath;
  }

  /**
   * Clear cache manually
   *
   * Useful for testing or forcing re-detection.
   * Normally not needed as cache is cleared automatically on settings change.
   */
  clearCache(): void {
    this.cache.clear();
    console.warn('[CLI Tools] Cache cleared');
  }

  /**
   * Get tool detection info for diagnostics
   *
   * Performs fresh detection without using cache.
   * Useful for Settings UI to show current detection status.
   *
   * @param tool - The tool to get detection info for
   * @returns Detection result with full metadata
   */
  getToolInfo(tool: CLITool): ToolDetectionResult {
    return this.detectToolPath(tool);
  }

  /**
   * Same as getToolInfo but detects without blocking the event loop.
   * Performs fresh detection without using cache.
   */
  async getToolInfoAsync(tool: CLITool): Promise<ToolDetectionResult> {
    return this.detectToolPathAsync(tool);
  }
}

// Singleton instance
const cliToolManager = new CLIToolManager();

/**
 * Get the path for a CLI tool
 *
 * Convenience function for accessing the tool manager singleton.
 * Uses cached path if available, otherwise auto-detects.
 *
 * @param tool - The CLI tool to get the path for
 * @returns The resolved path to the tool executable
 *
 * @example
 * ```typescript
 * import { getToolPath } from './cli-tool-manager';
 *
 * const pythonPath = getToolPath('python');
 * const gitPath = getToolPath('git');
 * const ghPath = getToolPath('gh');
 *
 * execSync(`${gitPath} status`, { cwd: projectPath });
 * ```
 */
export function getToolPath(tool: CLITool): string {
  return cliToolManager.getToolPath(tool);
}

/**
 * Get Claude CLI path for SDK usage
 *
 * Returns null when a .cmd file is detected on Windows, so the SDK
 * can use its bundled claude.exe instead. The SDK's bundled CLI is
 * a proper Windows executable that can be spawned by anyio.open_process().
 *
 * Use this function when passing a CLI path to the Claude Agent SDK.
 * For other uses (like spawning claude directly), use getToolPath('claude').
 *
 * @returns Claude CLI path, or null if SDK should use bundled CLI
 *
 * @example
 * ```typescript
 * import { getClaudeCliPathForSdk } from './cli-tool-manager';
 *
 * const cliPath = getClaudeCliPathForSdk();
 * // Pass to Python backend which uses Claude Agent SDK
 * // If null, SDK will use its bundled claude.exe
 * ```
 */
export function getClaudeCliPathForSdk(): string | null {
  return cliToolManager.getClaudeCliPathForSdk();
}

/**
 * Configure CLI tools with user settings
 *
 * Call this when user updates CLI tool paths in Settings.
 * Clears cache to force re-detection with new configuration.
 *
 * @param config - User configuration for CLI tool paths
 *
 * @example
 * ```typescript
 * import { configureTools } from './cli-tool-manager';
 *
 * // When settings are loaded or updated
 * configureTools({
 *   pythonPath: settings.pythonPath,
 *   gitPath: settings.gitPath,
 *   githubCLIPath: settings.githubCLIPath,
 * });
 * ```
 */
export function configureTools(config: ToolConfig): void {
  cliToolManager.configure(config);
}

/**
 * Get tool detection info for diagnostics
 *
 * Performs fresh detection and returns full metadata.
 * Useful for Settings UI to show detection status and version.
 *
 * @param tool - The tool to get detection info for
 * @returns Detection result with path, version, and source
 *
 * @example
 * ```typescript
 * import { getToolInfo } from './cli-tool-manager';
 *
 * const pythonInfo = getToolInfo('python');
 * console.log(`Found: ${pythonInfo.found}`);
 * console.log(`Path: ${pythonInfo.path}`);
 * console.log(`Version: ${pythonInfo.version}`);
 * console.log(`Source: ${pythonInfo.source}`);
 * ```
 */
export function getToolInfo(tool: CLITool): ToolDetectionResult {
  return cliToolManager.getToolInfo(tool);
}

/**
 * Async variant of getToolInfo: fresh detection (no cache) without blocking.
 */
export async function getToolInfoAsync(tool: CLITool): Promise<ToolDetectionResult> {
  return cliToolManager.getToolInfoAsync(tool);
}

/**
 * Clear tool path cache manually
 *
 * Forces re-detection on next getToolPath() call.
 * Normally not needed as cache is cleared automatically on settings change.
 *
 * @example
 * ```typescript
 * import { clearToolCache } from './cli-tool-manager';
 *
 * // Force re-detection (e.g., after installing new tools)
 * clearToolCache();
 * ```
 */
export function clearToolCache(): void {
  cliToolManager.clearCache();
}

/**
 * Check if a path appears to be from a different platform.
 * Useful for detecting cross-platform path issues in settings.
 *
 * @param pathStr - The path to check
 * @returns true if the path is from a different platform
 *
 * @example
 * ```typescript
 * import { isPathFromWrongPlatform } from './cli-tool-manager';
 *
 * // On macOS, this returns true for Windows paths
 * isPathFromWrongPlatform('C:\\Program Files\\claude.exe'); // true
 * isPathFromWrongPlatform('/usr/local/bin/claude'); // false
 * ```
 */
export function isPathFromWrongPlatform(pathStr: string | undefined): boolean {
  return isWrongPlatformPath(pathStr);
}

// ============================================================================
// ASYNC EXPORTS - Non-blocking alternatives for Electron main process
// ============================================================================

/**
 * Get the path for a CLI tool asynchronously (non-blocking)
 *
 * Safe to call from Electron main process without blocking the event loop.
 * Uses cached path if available, otherwise detects asynchronously.
 *
 * @param tool - The CLI tool to get the path for
 * @returns Promise resolving to the tool path
 *
 * @example
 * ```typescript
 * import { getToolPathAsync } from './cli-tool-manager';
 *
 * const claudePath = await getToolPathAsync('claude');
 * ```
 */
export async function getToolPathAsync(tool: CLITool): Promise<string> {
  return cliToolManager.getToolPathAsync(tool);
}

/**
 * Get Claude CLI path for SDK usage asynchronously (non-blocking)
 *
 * Returns null when a .cmd file is detected on Windows, so the SDK
 * can use its bundled claude.exe instead.
 *
 * @returns Promise resolving to Claude CLI path, or null if SDK should use bundled CLI
 *
 * @example
 * ```typescript
 * import { getClaudeCliPathForSdkAsync } from './cli-tool-manager';
 *
 * const cliPath = await getClaudeCliPathForSdkAsync();
 * // Pass to Python backend which uses Claude Agent SDK
 * ```
 */
export async function getClaudeCliPathForSdkAsync(): Promise<string | null> {
  return cliToolManager.getClaudeCliPathForSdkAsync();
}

/**
 * Pre-warm the CLI tool cache asynchronously
 *
 * Call this during app startup to detect tools in the background.
 * Subsequent calls to getToolPath/getToolPathAsync will use cached values.
 *
 * @param tools - Array of tools to pre-warm (defaults to ['claude'])
 *
 * @example
 * ```typescript
 * import { preWarmToolCache } from './cli-tool-manager';
 *
 * // In app startup
 * app.whenReady().then(() => {
 *   // ... setup code ...
 *   preWarmToolCache(['claude', 'git', 'gh']);
 * });
 * ```
 */
export async function preWarmToolCache(tools: CLITool[] = ['claude']): Promise<void> {
  console.warn('[CLI Tools] Pre-warming cache for:', tools.join(', '));
  await Promise.all(tools.map(tool => cliToolManager.getToolPathAsync(tool)));
  console.warn('[CLI Tools] Cache pre-warming complete');
}

