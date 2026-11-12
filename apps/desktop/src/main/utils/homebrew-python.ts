/**
 * Homebrew Python Detection Utility
 *
 * Shared logic for finding Python installations in Homebrew directories.
 * Used by both python-detector.ts and cli-tool-manager.ts to ensure
 * consistent Python detection across the application.
 */

import { existsSync } from 'fs';
import path from 'path';

import { appLog } from '../app-logger';
/**
 * Validation result for a Python installation.
 */
export interface PythonValidation {
  valid: boolean;
  version?: string;
  message: string;
}

/**
 * Candidate Homebrew Python paths in priority order.
 * Directories: Apple Silicon (/opt/homebrew/bin), then Intel (/usr/local/bin).
 * Names: specific versions newest to oldest, then generic python3.
 * Note: update the list when new Python versions are released.
 */
export function getHomebrewPythonPaths(): string[] {
  const homebrewDirs = [
    '/opt/homebrew/bin',  // Apple Silicon (M1/M2/M3)
    '/usr/local/bin'      // Intel Mac
  ];
  const pythonNames = [
    'python3.14',
    'python3.13',
    'python3.12',
    'python3.11',
    'python3.10',
    'python3',
  ];
  return homebrewDirs.flatMap((dir) => pythonNames.map((name) => path.join(dir, name)));
}

/**
 * Find the first valid Homebrew Python installation.
 * Checks common Homebrew paths for Python 3, including versioned installations.
 * Prioritizes newer Python versions (3.14, 3.13, 3.12, 3.11, 3.10).
 *
 * Note: This list should be updated when new Python versions are released.
 * Check for specific versions first to ensure we find the latest available version.
 *
 * @param validateFn - Function to validate a Python path and return validation result
 * @param logPrefix - Prefix for log messages (e.g., '[Python]', '[CLI Tools]')
 * @returns The path to Homebrew Python, or null if not found
 */
export function findHomebrewPython(
  validateFn: (pythonPath: string) => PythonValidation,
  logPrefix: string
): string | null {
  for (const pythonPath of getHomebrewPythonPaths()) {
    if (existsSync(pythonPath)) {
      try {
        // Validate that this Python meets version requirements
        const validation = validateFn(pythonPath);
        if (validation.valid) {
          appLog.info(`${logPrefix} Found valid Homebrew Python: ${pythonPath} (${validation.version})`);
          return pythonPath;
        } else {
          console.warn(`${logPrefix} ${pythonPath} rejected: ${validation.message}`);
        }
      } catch (error) {
        // Version check failed (e.g., timeout, permission issue), try next candidate
        console.warn(`${logPrefix} Failed to validate ${pythonPath}: ${error}`);
      }
    }
  }

  appLog.info(`${logPrefix} No valid Homebrew Python found in Homebrew directories`);
  return null;
}
