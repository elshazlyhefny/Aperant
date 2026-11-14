/**
 * zeenha fork: helpers shared by the outcome writers. Kept apart from
 * issue-writeback/common.ts so the Jira writeback does not start importing app-logger.
 */

import { appLog } from '../../app-logger';
import { GitLabAPIError } from '../gitlab/utils';

export function warn(provider: string, event: string, ref: string, err: unknown): void {
  try {
    let detail = 'UnknownError';
    if (err instanceof GitLabAPIError) {
      detail = `${err.name}${err.statusCode ? ` (HTTP ${err.statusCode})` : ''}`;
    } else if (err instanceof Error) {
      // githubFetch embeds the response body in its message, so only the name is logged
      detail = err.name;
    }
    appLog.warn(`[IssueWriteback] ${provider} comment failed event=${event} issue=${ref} reason=${detail}`);
  } catch {
    // never throw from logging
  }
}

export function isPositiveSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function parseUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
