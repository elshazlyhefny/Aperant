/**
 * Usage monitor logging helpers.
 */

/**
 * Create a safe fingerprint of a credential for debug logging.
 * Shows first 8 and last 4 characters, hiding the sensitive middle portion.
 * This is NOT for authentication - only for human-readable debug identification.
 *
 * @param credential - The credential (token or API key) to create a fingerprint for
 * @returns A safe fingerprint like "sk-ant-oa...xyz9" or "null" if no credential
 */
export function getCredentialFingerprint(credential: string | null | undefined): string {
  if (!credential) return 'null';
  if (credential.length <= 16) return credential.slice(0, 4) + '...' + credential.slice(-2);
  return credential.slice(0, 8) + '...' + credential.slice(-4);
}

export interface UsageLogger {
  /** Logs only when DEBUG=true */
  debugLog(message: string, data?: unknown): void;
  /** Logs only when VERBOSE=true (more granular than debug) */
  traceLog(message: string, data?: unknown): void;
}

/**
 * Create a logger. DEBUG/VERBOSE are read once, at construction time.
 */
export function createUsageLogger(): UsageLogger {
  const isDebug = process.env.DEBUG === 'true';
  const isVerbose = process.env.VERBOSE === 'true';

  const emit = (message: string, data?: unknown): void => {
    if (data !== undefined) {
      console.warn(message, data);
    } else {
      console.warn(message);
    }
  };

  return {
    debugLog(message, data) {
      if (isDebug) emit(message, data);
    },
    traceLog(message, data) {
      if (isVerbose) emit(message, data);
    },
  };
}
