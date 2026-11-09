/**
 * Debug Logger
 * Only logs when DEBUG=true or NODE_ENV=development.
 *
 * Renderer note: electron.vite.config.* defines no `process.env` replacement for the
 * renderer, so there `process` is typically undefined and logging stays disabled
 * (guarded below so it never throws). Main/preload/worker processes see the real env.
 */

export const isDebugEnabled = (): boolean => {
  if (typeof process !== 'undefined' && process.env) {
    return process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development';
  }
  return false;
};

function safeConsoleWarn(...args: unknown[]): void {
  try {
    console.warn(...args);
  } catch {
    // Ignore console stream failures (e.g. EIO) in debug logging paths.
  }
}

function safeConsoleError(...args: unknown[]): void {
  try {
    console.error(...args);
  } catch {
    // Ignore console stream failures (e.g. EIO) in debug logging paths.
  }
}

export const debugLog = (...args: unknown[]): void => {
  if (isDebugEnabled()) {
    safeConsoleWarn(...args);
  }
};

export const debugWarn = (...args: unknown[]): void => {
  if (isDebugEnabled()) {
    safeConsoleWarn(...args);
  }
};

export const debugError = (...args: unknown[]): void => {
  if (isDebugEnabled()) {
    safeConsoleError(...args);
  }
};

/**
 * Create a namespaced debug logger: output is `[namespace] message` (plus data when defined).
 * Callers must redact sensitive data (tokens, OAuth values) before logging.
 */
export function createDebugLog(namespace: string): (message: string, data?: unknown) => void {
  return (message: string, data?: unknown): void => {
    if (!isDebugEnabled()) return;
    if (data !== undefined) {
      safeConsoleWarn(`[${namespace}] ${message}`, data);
    } else {
      safeConsoleWarn(`[${namespace}] ${message}`);
    }
  };
}
