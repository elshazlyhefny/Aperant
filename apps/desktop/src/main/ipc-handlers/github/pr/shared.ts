/**
 * Shared state and helpers for the GitHub PR IPC handlers.
 *
 * runningReviews and ciWaitAbortControllers are single module-level instances;
 * every PR module must import them from here.
 */

import type { Project } from "../../../../shared/types";
import { createContextLogger } from "../utils/logger";

// Debug logging
export const { debug: debugLog, trace: traceLog } = createContextLogger("GitHub PR");

/**
 * Sentinel value indicating a review is waiting for CI checks to complete.
 * Used as a placeholder in runningReviews before the actual process is spawned.
 */
export const CI_WAIT_PLACEHOLDER = Symbol("CI_WAIT_PLACEHOLDER");
export type CIWaitPlaceholder = typeof CI_WAIT_PLACEHOLDER;

/**
 * Registry of running PR review abort controllers
 * Key format: `${projectId}:${prNumber}`
 * Value can be:
 * - AbortController: actual running review (used to cancel)
 * - CI_WAIT_PLACEHOLDER: review is waiting for CI checks to complete
 */
export const runningReviews = new Map<string, AbortController | CIWaitPlaceholder>();

/**
 * Registry of abort controllers for CI wait cancellation
 * Key format: `${projectId}:${prNumber}`
 */
export const ciWaitAbortControllers = new Map<string, AbortController>();

/**
 * Get the registry key for a PR review
 */
export function getReviewKey(projectId: string, prNumber: number): string {
  return `${projectId}:${prNumber}`;
}

/**
 * Returns env vars for Claude.md usage; enabled unless explicitly opted out.
 */
export function getClaudeMdEnv(project: Project): Record<string, string> | undefined {
  return project.settings?.useClaudeMd !== false ? { USE_CLAUDE_MD: "true" } : undefined;
}

/**
 * Sanitize network data before writing to file
 * Removes potentially dangerous characters and limits length
 */
export function sanitizeNetworkData(data: string, maxLength = 1000000): string {
  // Remove null bytes and other control characters except newlines/tabs/carriage returns
  // Using code points instead of escape sequences to avoid no-control-regex ESLint rule
  const controlCharsPattern = new RegExp(
    "[" +
      String.fromCharCode(0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08) + // \x00-\x08
      String.fromCharCode(0x0b, 0x0c) + // \x0B, \x0C (skip \x0A which is newline)
      String.fromCharCode(
        0x0e,
        0x0f,
        0x10,
        0x11,
        0x12,
        0x13,
        0x14,
        0x15,
        0x16,
        0x17,
        0x18,
        0x19,
        0x1a,
        0x1b,
        0x1c,
        0x1d,
        0x1e,
        0x1f
      ) + // \x0E-\x1F
      String.fromCharCode(0x7f) + // \x7F (DEL)
      "]",
    "g"
  );
  let sanitized = data.replace(controlCharsPattern, "");

  // Limit length to prevent DoS
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength);
  }

  return sanitized;
}
