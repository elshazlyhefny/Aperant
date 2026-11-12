import path from 'path';


/**
 * Escape single quotes in a path for safe use in single-quoted shell/script strings.
 * Works for both AppleScript and shell (bash/sh) contexts.
 * This prevents command injection via malicious directory names.
 */
export function escapeSingleQuotedPath(dirPath: string): string {
  // Single quotes are escaped by ending the string, adding an escaped quote,
  // and starting a new string: ' -> '\''
  // This pattern works in both AppleScript and POSIX shells (bash, sh, zsh)
  return dirPath.replace(/'/g, "'\\''");
}

/**
 * Validate a path doesn't contain path traversal attempts after variable expansion
 */
export function isPathSafe(expandedPath: string): boolean {
  // Normalize and check for path traversal
  const normalized = path.normalize(expandedPath);
  // Check for explicit traversal patterns
  if (normalized.includes('..')) {
    return false;
  }
  return true;
}

/**
 * Escape a string for use inside AppleScript double-quoted strings.
 * In AppleScript:
 * - Backslashes must be escaped: \ → \\
 * - Double quotes must be escaped: " → \"
 * - Single quotes do NOT need escaping inside double-quoted strings
 */
export function escapeAppleScriptString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')  // Escape backslashes first
    .replace(/"/g, '\\"');   // Escape double quotes
}

/**
 * Escape a string for safe use in PowerShell -Command context.
 * PowerShell requires escaping backticks, double quotes, dollar signs,
 * parentheses, semicolons, and ampersands.
 */
export function escapePowerShellCommand(str: string): string {
  return str
    .replace(/`/g, '``')      // Escape backticks (PowerShell escape char)
    .replace(/"/g, '`"')      // Escape double quotes
    .replace(/\$/g, '`$')     // Escape dollar signs (variable expansion)
    .replace(/\(/g, '`(')     // Escape opening parentheses
    .replace(/\)/g, '`)')     // Escape closing parentheses
    .replace(/;/g, '`;')      // Escape semicolons (statement separator)
    .replace(/&/g, '`&')      // Escape ampersands (call operator)
    .replace(/\r/g, '`r')     // Escape carriage returns
    .replace(/\n/g, '`n');    // Escape newlines
}

/**
 * Escape a string for safe use in Git Bash -c context.
 * Bash requires escaping single quotes, double quotes, backslashes, and other metacharacters.
 */
export function escapeGitBashCommand(str: string): string {
  // For bash -c with double quotes, escape: backslash, double quote, dollar, backtick,
  // semicolon, pipe, and exclamation mark (all bash metacharacters that could allow command injection)
  return str
    .replace(/\\/g, '\\\\')   // Escape backslashes first
    .replace(/"/g, '\\"')     // Escape double quotes
    .replace(/\$/g, '\\$')    // Escape dollar signs
    .replace(/`/g, '\\`')     // Escape backticks
    .replace(/;/g, '\\;')     // Escape semicolons (command separator)
    .replace(/\|/g, '\\|')    // Escape pipes (command piping)
    .replace(/!/g, '\\!');    // Escape exclamation marks (history expansion)
}

/**
 * Escape a string for safe use in bash -c context (Linux terminals).
 * Uses the same escaping rules as escapeGitBashCommand for consistency.
 * Defense-in-depth: Currently all commands come from trusted sources (getInstallCommand,
 * getInstallVersionCommand), but this prevents potential command injection if future
 * code adds new call sites with less controlled input.
 */
export function escapeBashCommand(str: string): string {
  // Reuse the same escaping logic as Git Bash
  return escapeGitBashCommand(str);
}
