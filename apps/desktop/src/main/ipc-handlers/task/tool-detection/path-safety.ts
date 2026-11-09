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
