/**
 * Shared debug logging utilities for GitHub handlers
 */

import { createDebugLog, debugWarn } from '../../../../shared/utils/debug-logger';

const isVerbose = (): boolean => process.env.VERBOSE === 'true';

function emit(context: string, message: string, data?: unknown): void {
  if (data !== undefined) {
    debugWarn(`[${context}] ${message}`, data);
  } else {
    debugWarn(`[${context}] ${message}`);
  }
}

/**
 * Create a context-specific logger
 */
export function createContextLogger(context: string): {
  debug: (message: string, data?: unknown) => void;
  trace: (message: string, data?: unknown) => void;
} {
  return {
    debug: createDebugLog(context),
    trace: (message: string, data?: unknown): void => {
      if (isVerbose()) emit(context, message, data);
    },
  };
}

/**
 * Log message with context (legacy compatibility)
 */
export function debugLog(context: string, message: string, data?: unknown): void {
  createDebugLog(context)(message, data);
}

/**
 * Trace log message with context - only emitted when VERBOSE=true
 */
export function traceLog(context: string, message: string, data?: unknown): void {
  if (isVerbose()) emit(context, message, data);
}
