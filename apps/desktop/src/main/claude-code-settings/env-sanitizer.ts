/**
 * Environment Variable Sanitizer
 *
 * Filters dangerous environment variables from Claude Code settings to prevent
 * supply chain attacks via malicious project settings.json files.
 *
 * Attack Vector:
 * A malicious repository can include .claude/settings.json (committed file) with
 * dangerous env vars like LD_PRELOAD, NODE_OPTIONS, etc. When a user opens the
 * project and creates a terminal, these vars get injected into the PTY process,
 * enabling arbitrary code execution.
 *
 * Defense Strategy:
 * - Block environment variables that enable code injection
 * - Log warnings for blocked variables
 * - Project-level settings (projectShared/projectLocal) are untrusted: on top of the
 *   dangerous list they also lose credential-redirect, proxy/TLS, git, editor/pager,
 *   HOME/config-dir, PATH and SHELL variables (see PROJECT_BLOCKED_* below)
 * - User and managed settings are trusted and may set PATH, SHELL and the like
 */

import { debugLog, debugError } from '../../shared/utils/debug-logger';

const LOG_PREFIX = '[EnvSanitizer]';

/**
 * Environment variables that enable arbitrary code execution and MUST be blocked.
 * These variables allow attackers to inject malicious libraries, scripts, or commands
 * into the runtime environment.
 *
 * Categories:
 * - Dynamic linker injection (LD_*, DYLD_*)
 * - Runtime module loaders (NODE_OPTIONS, PYTHON*, RUBY*, PERL*)
 * - Shell initialization (BASH_ENV, ENV, ZDOTDIR, INPUTRC)
 * - JVM injection (JAVA_TOOL_OPTIONS, MAVEN_OPTS, GRADLE_OPTS)
 * - Package manager hijacking (NPM_CONFIG_PREFIX, YARN_RC_FILENAME, COMPOSER_HOME)
 * - Path manipulation that can hijack commands (CDPATH)
 */
const DANGEROUS_ENV_VARS = new Set([
  // Linux/Unix dynamic linker - allows loading arbitrary shared libraries
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'LD_BIND_NOW',
  'LD_DEBUG',

  // macOS dynamic linker - allows loading arbitrary dylibs/frameworks
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH',
  'DYLD_FALLBACK_FRAMEWORK_PATH',
  'DYLD_VERSIONED_LIBRARY_PATH',
  'DYLD_VERSIONED_FRAMEWORK_PATH',

  // Node.js - allows arbitrary module loading and flag injection
  'NODE_OPTIONS',
  'NODE_PATH',

  // Python - allows running arbitrary Python code at startup
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'PYTHONINSPECT',

  // Ruby - allows injecting arbitrary Ruby code
  'RUBYOPT',
  'RUBYLIB',

  // Perl - allows injecting arbitrary Perl code
  'PERL5OPT',
  'PERLLIB',
  'PERL5LIB',

  // Shell initialization - allows running arbitrary commands
  'BASH_ENV',
  'ENV',
  'ZDOTDIR', // zsh startup directory hijacking
  'PROMPT_COMMAND',
  'INPUTRC', // readline command injection

  // Path manipulation - can cause 'cd' to execute malicious code
  'CDPATH',

  // JVM injection - allows arbitrary agent/code loading
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'MAVEN_OPTS',
  'GRADLE_OPTS',

  // Python additional - user site-packages hijacking
  'PYTHONUSERBASE',

  // Package manager hijacking
  'NPM_CONFIG_PREFIX',
  'YARN_RC_FILENAME',
  'COMPOSER_HOME',

  // Git injection
  'GIT_TRACE',
  'GIT_TRACE_PACKET',
  'GIT_TRACE_PERFORMANCE',
  'GIT_SSH_COMMAND',
  'GIT_ALLOW_PROTOCOL',
]);

/**
 * Environment variables that should trigger warnings when set from project-level
 * settings (shared or local), but are not blocked entirely.
 * (PATH and SHELL are now dropped outright at project levels.)
 */
const WARNING_ENV_VARS = new Set([
  'TERM', // Can affect terminal behavior in unexpected ways
]);

type SettingsLevel = 'user' | 'projectShared' | 'projectLocal' | 'managed';

/**
 * Exact names dropped when they come from project-level settings. A committed
 * settings file must not redirect credentials, traffic, git, or the home directory.
 */
const PROJECT_BLOCKED_ENV_VARS = new Set([
  // Credential / endpoint redirection and proxies
  'ANTHROPIC_BASE_URL',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  // TLS trust
  'NODE_EXTRA_CA_CERTS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  // Git configuration and helpers
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_COUNT',
  'GIT_EXEC_PATH',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GIT_EXTERNAL_DIFF',
  'GIT_PROXY_COMMAND',
  'GIT_PAGER',
  'GIT_EDITOR',
  'GIT_SEQUENCE_EDITOR',
  // Pagers, editors, openers
  'PAGER',
  'MANPAGER',
  'EDITOR',
  'VISUAL',
  'BROWSER',
  'LESSOPEN',
  'LESSCLOSE',
  // Home / config directories and credentials
  'HOME',
  'XDG_CONFIG_HOME',
  'USERPROFILE',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_OAUTH_TOKEN',
  // Command resolution
  'PATH',
  'SHELL',
]);

/** Prefixes (matched on the upper-cased key) dropped from project-level settings. */
const PROJECT_BLOCKED_PREFIXES = ['GIT_', 'ANTHROPIC_', 'NPM_CONFIG_', 'LD_', 'DYLD_'];

/** Suffixes (matched on the upper-cased key) dropped from project-level settings. */
const PROJECT_BLOCKED_SUFFIXES = ['_PROXY', '_BASE_URL'];

export interface DroppedEnvVar {
  /** Variable name only; values are never recorded. */
  key: string;
  reason: 'dangerous' | 'project-policy';
  level: SettingsLevel;
}

export interface SanitizeEnvReport {
  env: Record<string, string>;
  dropped: DroppedEnvVar[];
}

function isProjectLevel(level: SettingsLevel): boolean {
  return level === 'projectShared' || level === 'projectLocal';
}

/**
 * Sanitize environment variables and report which keys were dropped and why.
 *
 * @param env - Raw environment variables from settings.json
 * @param sourceLevel - The settings level these vars came from
 */
export function sanitizeEnvVarsWithReport(
  env: Record<string, string> | undefined,
  sourceLevel: SettingsLevel = 'user'
): SanitizeEnvReport {
  if (!env || typeof env !== 'object') {
    return { env: {}, dropped: [] };
  }

  const sanitized: Record<string, string> = {};
  const dropped: DroppedEnvVar[] = [];
  const blocked: string[] = [];
  const policyDropped: string[] = [];
  const warned: string[] = [];
  const projectLevel = isProjectLevel(sourceLevel);

  for (const [key, value] of Object.entries(env)) {
    // Validate key and value types
    if (typeof key !== 'string' || typeof value !== 'string') {
      debugError(`${LOG_PREFIX} Invalid env var type: ${typeof key}=${typeof value}`);
      continue;
    }

    const upperKey = key.toUpperCase();

    // Block dangerous variables at every level
    if (DANGEROUS_ENV_VARS.has(upperKey)) {
      blocked.push(key);
      dropped.push({ key, reason: 'dangerous', level: sourceLevel });
      debugError(
        `${LOG_PREFIX} BLOCKED dangerous env var from ${sourceLevel}: ${key}`,
        '(prevents code injection attack)'
      );
      continue;
    }

    if (projectLevel) {
      // Project settings are untrusted: drop credential/git/proxy/path redirects
      if (isProjectBlockedEnvVar(key)) {
        policyDropped.push(key);
        dropped.push({ key, reason: 'project-policy', level: sourceLevel });
        debugError(`${LOG_PREFIX} DROPPED env var from ${sourceLevel} by project policy: ${key}`);
        continue;
      }

      if (WARNING_ENV_VARS.has(upperKey)) {
        warned.push(key);
        debugLog(
          `${LOG_PREFIX} WARNING: ${key} set from ${sourceLevel} settings`,
          '(can affect command execution, verify this is intentional)'
        );
      }
    }

    sanitized[key] = value;
  }

  // Log summary if any variables were filtered
  if (blocked.length > 0) {
    debugError(
      `${LOG_PREFIX} Blocked ${blocked.length} dangerous env var(s) from ${sourceLevel}:`,
      blocked.join(', ')
    );
  }

  if (policyDropped.length > 0) {
    debugError(
      `${LOG_PREFIX} Dropped ${policyDropped.length} project-policy env var(s) from ${sourceLevel}:`,
      policyDropped.join(', ')
    );
  }

  if (warned.length > 0) {
    debugLog(
      `${LOG_PREFIX} ${warned.length} potentially dangerous env var(s) from ${sourceLevel}:`,
      warned.join(', ')
    );
  }

  return { env: sanitized, dropped };
}

/**
 * Sanitize environment variables by removing dangerous entries that could enable
 * supply chain attacks. Thin wrapper over sanitizeEnvVarsWithReport.
 *
 * @param env - Raw environment variables from settings.json
 * @param sourceLevel - The settings level these vars came from (for logging)
 * @returns Sanitized environment variables with dangerous entries removed
 */
export function sanitizeEnvVars(
  env: Record<string, string> | undefined,
  sourceLevel: SettingsLevel = 'user'
): Record<string, string> {
  return sanitizeEnvVarsWithReport(env, sourceLevel).env;
}

/**
 * Check if an environment variable is dropped when set from project-level settings
 * (exact name, prefix, or suffix rule). Case-insensitive.
 */
export function isProjectBlockedEnvVar(key: string): boolean {
  const upperKey = key.toUpperCase();
  return (
    PROJECT_BLOCKED_ENV_VARS.has(upperKey) ||
    PROJECT_BLOCKED_PREFIXES.some((prefix) => upperKey.startsWith(prefix)) ||
    PROJECT_BLOCKED_SUFFIXES.some((suffix) => upperKey.endsWith(suffix))
  );
}

/**
 * Get the exact-name list of project-blocked variables (prefix/suffix rules excluded).
 */
export function getProjectBlockedEnvVars(): string[] {
  return Array.from(PROJECT_BLOCKED_ENV_VARS).sort();
}

/**
 * Check if an environment variable is considered dangerous.
 * Useful for validation and testing.
 */
export function isDangerousEnvVar(key: string): boolean {
  return DANGEROUS_ENV_VARS.has(key.toUpperCase());
}

/**
 * Check if an environment variable should trigger a warning when set from
 * project-level settings.
 */
export function isWarningEnvVar(key: string): boolean {
  return WARNING_ENV_VARS.has(key.toUpperCase());
}

/**
 * Get the complete list of blocked environment variable names.
 * Useful for documentation and testing.
 */
export function getDangerousEnvVars(): string[] {
  return Array.from(DANGEROUS_ENV_VARS).sort();
}

/**
 * Get the complete list of warning environment variable names.
 * Useful for documentation and testing.
 */
export function getWarningEnvVars(): string[] {
  return Array.from(WARNING_ENV_VARS).sort();
}
