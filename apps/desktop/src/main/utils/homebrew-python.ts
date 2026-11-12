/**
 * Homebrew Python Detection Utility
 *
 * The list of Homebrew Python locations, consumed by the Python entry in
 * cli-tools/specs.ts.
 */

import path from 'path';

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
