import path from 'path';
import { existsSync, readdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { minimatch } from 'minimatch';
import { debugLog, debugError } from '../../shared/utils/debug-logger';
import { getIsolatedGitEnv } from './git-isolation';
import { getToolPath } from '../cli-tool-manager';

// Validation regex for git branch names - allows alphanumeric, dots, slashes, dashes, underscores
export const GIT_BRANCH_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;

/**
 * Fix repositories that are incorrectly marked with core.bare=true.
 * This can happen when git worktree operations incorrectly set bare=true
 * on a working repository that has source files.
 *
 * This is the single source of truth for both the task worktree and the
 * terminal worktree flows. Every git call here must use getIsolatedGitEnv()
 * (see git-isolation.ts): inherited GIT_DIR/GIT_WORK_TREE would make git read
 * or modify the wrong repository's config, and husky hooks must be disabled.
 *
 * Returns true if a fix was applied, false otherwise.
 */
export function fixMisconfiguredBareRepo(projectPath: string): boolean {
  try {
    // Check if bare=true is set
    const bareConfig = execFileSync(
      getToolPath('git'),
      ['config', '--get', 'core.bare'],
      { cwd: projectPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: getIsolatedGitEnv() }
    ).trim().toLowerCase();

    if (bareConfig !== 'true') {
      return false; // Not marked as bare, nothing to fix
    }

    // Check if there are source files (indicating misconfiguration)
    // A truly bare repo would only have git internals, not source code
    // This covers multiple ecosystems: JS/TS, Python, Rust, Go, Java, C#, etc.
    const EXACT_MARKERS = [
      // JavaScript/TypeScript ecosystem
      'package.json', 'apps', 'src',
      // Python ecosystem
      'pyproject.toml', 'setup.py', 'requirements.txt', 'Pipfile',
      // Rust ecosystem
      'Cargo.toml',
      // Go ecosystem
      'go.mod', 'go.sum', 'cmd', 'main.go',
      // Java/JVM ecosystem
      'pom.xml', 'build.gradle', 'build.gradle.kts',
      // Ruby ecosystem
      'Gemfile', 'Rakefile',
      // PHP ecosystem
      'composer.json',
      // General project markers
      'Makefile', 'CMakeLists.txt', 'README.md', 'LICENSE'
    ];

    const GLOB_MARKERS = [
      // .NET/C# ecosystem - patterns that need glob matching
      '*.csproj', '*.sln', '*.fsproj'
    ];

    // Check exact matches first (fast path)
    const hasExactMatch = EXACT_MARKERS.some(marker =>
      existsSync(path.join(projectPath, marker))
    );

    if (hasExactMatch) {
      // Found a project marker, proceed to fix
    } else {
      // Check glob patterns - read directory once and cache for all patterns
      let directoryFiles: string[] | null = null;
      const MAX_FILES_TO_CHECK = 500;

      const hasGlobMatch = GLOB_MARKERS.some(pattern => {
        // Validate pattern - only support simple glob patterns for security
        if (pattern.includes('..') || pattern.includes('/')) {
          debugLog('[GitRepoRepair] Unsupported glob pattern ignored:', pattern);
          return false;
        }

        // Lazy-load directory listing, cached across patterns
        if (directoryFiles === null) {
          try {
            const allFiles = readdirSync(projectPath);
            directoryFiles = allFiles.slice(0, MAX_FILES_TO_CHECK);
            if (allFiles.length > MAX_FILES_TO_CHECK) {
              debugLog(`[GitRepoRepair] Directory has ${allFiles.length} entries, checking only first ${MAX_FILES_TO_CHECK}`);
            }
          } catch (error) {
            debugError('[GitRepoRepair] Failed to read directory:', error);
            directoryFiles = [];
          }
        }

        // Use minimatch for proper glob pattern matching
        return directoryFiles.some(file => minimatch(file, pattern, { nocase: true }));
      });

      if (!hasGlobMatch) {
        return false; // Legitimately bare repo
      }
    }

    // Fix the misconfiguration
    debugLog('[GitRepoRepair] Detected misconfigured bare repository with source files. Auto-fixing by unsetting core.bare...');
    execFileSync(
      getToolPath('git'),
      ['config', '--unset', 'core.bare'],
      { cwd: projectPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: getIsolatedGitEnv() }
    );
    debugLog('[GitRepoRepair] Fixed: core.bare has been unset. Git operations should now work correctly.');
    return true;
  } catch {
    return false;
  }
}
