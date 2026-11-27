/**
 * zeenha fork: helpers shared by the outcome writers. Kept apart from
 * issue-writeback/common.ts so the Jira writeback does not start importing app-logger.
 */

import type { DeliveryOperation, DeliveryResult } from '../../../shared/types/delivery-receipt';
import type { DeliveryReceiptRecorder } from '../../delivery-receipts';
import { appLogPort } from '../../log-port';
import { GitLabAPIError } from '../gitlab/gitlab-api';
import { AzureDevOpsAPIError } from '../azuredevops/utils';

type SkipReason = Extract<DeliveryResult, { status: 'skipped' }>['reason'];

export function skipWriteback(
  recorder: DeliveryReceiptRecorder | undefined,
  operation: DeliveryOperation,
  reason: SkipReason
): void | Promise<void> {
  if (!recorder) return;
  return Promise.resolve().then(() => recorder.skip(operation, reason)).then(() => undefined, () => undefined);
}

/** zeenha fork: recorder failure before or after a mutation must not change the send count. */
export async function trackWriteback(
  recorder: DeliveryReceiptRecorder | undefined,
  operation: DeliveryOperation,
  send: () => Promise<DeliveryResult>
): Promise<void> {
  if (!recorder) {
    await send();
    return;
  }
  let sending: Promise<DeliveryResult> | undefined;
  const sendOnce = () => (sending ??= Promise.resolve().then(send));
  try {
    await recorder.track(operation, sendOnce);
  } catch {
    // Use the original promise if already started; never repeat the mutation.
  }
  await sendOnce();
}

/** Classify mutation failures only from typed HTTP status or the error kind, never message text. */
export function classifyWritebackError(err: unknown, statusCode?: number): DeliveryResult {
  const attempts = 1;
  if (statusCode === 408) return { status: 'unknown', reason: 'timeout', attempts, httpStatus: statusCode };
  if (statusCode !== undefined && Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599) {
    if (statusCode >= 400 && statusCode < 500) {
      return { status: 'failed', reason: statusCode === 429 ? 'rate_limited' : 'rejected', attempts, httpStatus: statusCode };
    }
    // A proxy/server error may arrive after the provider has written the comment.
    return { status: 'unknown', reason: 'ambiguous_response', attempts, httpStatus: statusCode };
  }
  if (statusCode === 0 || (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'))) {
    return { status: 'unknown', reason: 'timeout', attempts };
  }
  return { status: 'unknown', reason: err instanceof SyntaxError ? 'ambiguous_response' : 'transport_error', attempts };
}

export function warn(provider: string, event: string, ref: string, err: unknown, what = 'comment'): void {
  try {
    let detail = 'UnknownError';
    if (err instanceof GitLabAPIError) {
      detail = `${err.name}${err.statusCode ? ` (HTTP ${err.statusCode})` : ''}`;
    } else if (err instanceof AzureDevOpsAPIError) {
      // the message embeds a response body, so only name and status are logged
      detail = `${err.name}${err.statusCode ? ` (HTTP ${err.statusCode})` : ''}`;
    } else if (err instanceof Error) {
      // githubFetch embeds the response body in its message, so only the name is logged
      detail = err.name;
    }
    appLogPort.warn(`[IssueWriteback] ${provider} ${what} failed event=${event} issue=${ref} reason=${detail}`);
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
