/**
 * Git Validators
 * ==============
 *
 * Validators for git operations:
 * - Commit with secret scanning
 * - Config protection (prevent setting identity fields)
 * - zeenha fork: block core.hooksPath/core.fsmonitor and writes into
 *   .git/hooks or .git/config. These are speed bumps that obfuscation can
 *   bypass; the OS sandbox is the real control.
 *
 * See apps/desktop/src/main/ai/security/validators/git-validators.ts for the TypeScript implementation.
 */

import type { ValidationResult } from '../bash-validator';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Git config keys that agents must NOT modify.
 * These are identity settings that should inherit from the user's global config.
 */
const BLOCKED_GIT_CONFIG_KEYS = new Set([
  'user.name',
  'user.email',
  'author.name',
  'author.email',
  'committer.name',
  'committer.email',
]);

/**
 * zeenha fork: git config keys that make git run arbitrary programs (hooks,
 * fsmonitor). Lowercase because git config keys are case-insensitive.
 * This is a speed bump, not a sandbox: obfuscation (variables, eval, scripts,
 * GIT_CONFIG_* env vars) can bypass it. The OS sandbox is the real control.
 */
const BLOCKED_GIT_HOOK_CONFIG_KEYS = new Set(['core.hookspath', 'core.fsmonitor']);

function hookConfigDenied(source: string, key: string): ValidationResult {
  return [
    false,
    `BLOCKED: Cannot set git hook configuration\n\n` +
      `You attempted to set '${key}' via ${source}, which can make git run ` +
      `arbitrary programs.\n\n` +
      `WHY: Hook and fsmonitor settings execute code outside the agent's tool ` +
      `controls. This check is a speed bump that can be bypassed by obfuscation; ` +
      `the OS sandbox is the real control.\n\n` +
      `WHAT TO DO: Do not change core.hooksPath or core.fsmonitor.`,
  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shellSplit(input: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let i = 0;
  let inSingle = false;
  let inDouble = false;

  while (i < input.length) {
    const ch = input[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else current += ch;
      i++;
      continue;
    }
    if (inDouble) {
      if (ch === '\\' && i + 1 < input.length) {
        current += input[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inDouble = false;
      else current += ch;
      i++;
      continue;
    }
    if (ch === '\\' && i + 1 < input.length) {
      current += input[i + 1];
      i += 2;
      continue;
    }
    if (ch === "'") { inSingle = true; i++; continue; }
    if (ch === '"') { inDouble = true; i++; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (current.length > 0) { tokens.push(current); current = ''; }
      i++;
      continue;
    }
    current += ch;
    i++;
  }

  if (inSingle || inDouble) return null;
  if (current.length > 0) tokens.push(current);
  return tokens;
}

// ---------------------------------------------------------------------------
// Sub-validators
// ---------------------------------------------------------------------------

/**
 * Validate git config commands — block identity changes.
 *
 * Ported from: validate_git_config()
 */
function validateGitConfig(commandString: string): ValidationResult {
  const tokens = shellSplit(commandString);
  if (tokens === null) {
    return [false, 'Could not parse git command'];
  }

  if (tokens.length < 2 || tokens[0] !== 'git' || tokens[1] !== 'config') {
    return [true, '']; // Not a git config command
  }

  // Check for read-only operations first — always allowed
  const readOnlyFlags = new Set(['--get', '--get-all', '--get-regexp', '--list', '-l']);
  for (const token of tokens.slice(2)) {
    if (readOnlyFlags.has(token)) {
      return [true, ''];
    }
  }

  // Extract the config key (first non-option token after "config")
  let configKey: string | null = null;
  for (const token of tokens.slice(2)) {
    if (token.startsWith('-')) continue;
    configKey = token.toLowerCase();
    break;
  }

  if (!configKey) {
    return [true, '']; // No config key specified
  }

  if (BLOCKED_GIT_HOOK_CONFIG_KEYS.has(configKey)) {
    return hookConfigDenied('git config', configKey);
  }

  if (BLOCKED_GIT_CONFIG_KEYS.has(configKey)) {
    return [
      false,
      `BLOCKED: Cannot modify git identity configuration\n\n` +
        `You attempted to set '${configKey}' which is not allowed.\n\n` +
        `WHY: Git identity (user.name, user.email) must inherit from the user's ` +
        `global git configuration. Setting fake identities like 'Test User' breaks ` +
        `commit attribution and causes serious issues.\n\n` +
        `WHAT TO DO: Simply commit without setting any user configuration. ` +
        `The repository will use the correct identity automatically.`,
    ];
  }

  return [true, ''];
}

/**
 * Check for blocked config keys passed via git -c flag.
 *
 * Ported from: validate_git_inline_config()
 */
function validateGitInlineConfig(tokens: string[]): ValidationResult {
  let i = 1; // Start after 'git'
  while (i < tokens.length) {
    const token = tokens[i];

    if (token === '-c') {
      // Next token should be key=value
      if (i + 1 < tokens.length) {
        const configPair = tokens[i + 1];
        if (configPair.includes('=')) {
          const configKey = configPair.split('=')[0].toLowerCase();
          if (BLOCKED_GIT_HOOK_CONFIG_KEYS.has(configKey)) {
            return hookConfigDenied('the -c flag', configKey);
          }
          if (BLOCKED_GIT_CONFIG_KEYS.has(configKey)) {
            return [
              false,
              `BLOCKED: Cannot set git identity via -c flag\n\n` +
                `You attempted to use '-c ${configPair}' which sets a blocked ` +
                `identity configuration.\n\n` +
                `WHY: Git identity (user.name, user.email) must inherit from the ` +
                `user's global git configuration. Setting fake identities breaks ` +
                `commit attribution and causes serious issues.\n\n` +
                `WHAT TO DO: Remove the -c flag and commit normally. ` +
                `The repository will use the correct identity automatically.`,
            ];
          }
        }
        i += 2; // Skip -c and its value
        continue;
      }
    } else if (token.startsWith('-c') && token.length > 2) {
      // Handle -ckey=value format (no space)
      const configPair = token.slice(2);
      if (configPair.includes('=')) {
        const configKey = configPair.split('=')[0].toLowerCase();
        if (BLOCKED_GIT_HOOK_CONFIG_KEYS.has(configKey)) {
          return hookConfigDenied('the -c flag', configKey);
        }
        if (BLOCKED_GIT_CONFIG_KEYS.has(configKey)) {
          return [
            false,
            `BLOCKED: Cannot set git identity via -c flag\n\n` +
              `You attempted to use '${token}' which sets a blocked ` +
              `identity configuration.\n\n` +
              `WHY: Git identity (user.name, user.email) must inherit from the ` +
              `user's global git configuration. Setting fake identities breaks ` +
              `commit attribution and causes serious issues.\n\n` +
              `WHAT TO DO: Remove the -c flag and commit normally. ` +
              `The repository will use the correct identity automatically.`,
          ];
        }
      }
    }

    i++;
  }

  return [true, ''];
}

// ---------------------------------------------------------------------------
// .git internals write guard
// ---------------------------------------------------------------------------

const GIT_INTERNALS_PATH = String.raw`\.git[\\/](?:hooks|config)(?![\w-])`;
const GIT_INTERNALS_REDIRECT = new RegExp(String.raw`>{1,2}\|?\s*["']?[^\s"'<>|;&]*${GIT_INTERNALS_PATH}`, 'i');
const GIT_INTERNALS_TOKEN = new RegExp(GIT_INTERNALS_PATH, 'i');
const WRITING_COMMANDS = new Set(['tee', 'cp', 'mv', 'ln', 'install', 'chmod', 'rsync']);

/**
 * zeenha fork: deny commands that write into .git/hooks or .git/config.
 *
 * SPEED BUMP ONLY: this is a lexical check and can be bypassed by obfuscation
 * (variables, eval, scripts, symlinks). The OS sandbox is the real control.
 * Reads such as `ls .git/hooks` or `cat .git/config` are allowed.
 */
export function validateGitInternalsWrite(command: string): ValidationResult {
  const deny = (how: string): ValidationResult => [
    false,
    `BLOCKED: Cannot write into .git/hooks or .git/config (${how})\n\n` +
      `WHY: Hooks and git config run arbitrary programs outside the agent's tool ` +
      `controls. This check is a speed bump that can be bypassed by obfuscation; ` +
      `the OS sandbox is the real control.\n\n` +
      `WHAT TO DO: Do not modify files under .git/hooks or .git/config.`,
  ];

  if (GIT_INTERNALS_REDIRECT.test(command)) {
    return deny('output redirection');
  }

  for (const segment of command.split(/[;&|\n]+/)) {
    if (!GIT_INTERNALS_TOKEN.test(segment)) continue;
    const tokens = segment
      .trim()
      .split(/\s+/)
      .map((t) => t.replace(/^["']|["']$/g, ''))
      .filter((t) => t.length > 0);
    // Skip leading VAR=value assignments and common wrappers
    let idx = 0;
    while (idx < tokens.length && (/^\w+=/.test(tokens[idx]) || tokens[idx] === 'sudo' || tokens[idx] === 'command')) idx++;
    const name = (tokens[idx] ?? '').split(/[\\/]/).pop() ?? '';
    const args = tokens.slice(idx + 1);
    const touches = (t: string) => GIT_INTERNALS_TOKEN.test(t);

    if (WRITING_COMMANDS.has(name) && args.some(touches)) {
      // cp/install/rsync/ln only write to the final argument; mv also removes sources
      if (name === 'cp' || name === 'install' || name === 'rsync' || name === 'ln') {
        const operands = args.filter((a) => !a.startsWith('-'));
        if (operands.length > 0 && touches(operands[operands.length - 1])) return deny(name);
        continue;
      }
      return deny(name);
    }
    if (name === 'sed' && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place')) && args.some(touches)) {
      return deny('sed -i');
    }
    if (name === 'dd' && args.some((a) => a.startsWith('of=') && touches(a))) {
      return deny('dd');
    }
  }

  return [true, ''];
}

// ---------------------------------------------------------------------------
// Main validator
// ---------------------------------------------------------------------------

/**
 * Main git validator that checks all git security rules.
 *
 * Currently validates:
 * - git -c: Block identity changes via inline config on ANY git command
 * - git config: Block identity changes
 * - git commit: Secret scanning (delegated to scan-secrets module)
 *
 * Ported from: validate_git_command() / validate_git_commit (alias)
 */
export function validateGitCommand(commandString: string): ValidationResult {
  const tokens = shellSplit(commandString);
  if (tokens === null) {
    return [false, 'Could not parse git command'];
  }

  if (tokens.length === 0 || tokens[0] !== 'git') {
    return [true, ''];
  }

  if (tokens.length < 2) {
    return [true, '']; // Just "git" with no subcommand
  }

  // Check for blocked -c flags on ANY git command (security bypass prevention)
  const [inlineValid, inlineError] = validateGitInlineConfig(tokens);
  if (!inlineValid) {
    return [false, inlineError];
  }

  // Find the actual subcommand (skip global options like -c, -C, --git-dir, etc.)
  let subcommand: string | null = null;
  let skipNext = false;
  for (const token of tokens.slice(1)) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (token === '-c' || token === '-C' || token === '--git-dir' || token === '--work-tree') {
      skipNext = true;
      continue;
    }
    if (token.startsWith('-')) continue;
    subcommand = token;
    break;
  }

  if (!subcommand) {
    return [true, '']; // No subcommand found
  }

  // Check git config commands
  if (subcommand === 'config') {
    return validateGitConfig(commandString);
  }

  // git commit: secret scanning is handled at a higher level in the Python backend.
  // In the TypeScript port we allow git commit (secrets scanning is async/file-based
  // and would require spawning a subprocess — left to the git hook layer).
  // The identity protection checks above still apply.

  return [true, ''];
}
