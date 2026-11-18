/**
 * zeenha fork: user approval of a project-declared task webhook URL.
 *
 * A committed project file can declare a webhook URL, which is UNTRUSTED: it
 * must not receive task data until the user approved that exact URL. Approvals
 * are stored per project outside the repository (webhook-approval-store.ts);
 * this module only holds the pure, electron-free logic. Only a hash of the URL
 * is stored so the URL (which may embed a secret path) is not persisted.
 */

import { createHash } from 'crypto';

export type WebhookApprovals = {
  /** hashWebhookUrl() values (sha256 hex) of approved URLs */
  urls: string[];
};

export function hashWebhookUrl(url: string): string {
  return createHash('sha256').update(url.trim()).digest('hex');
}

export function isWebhookUrlApproved(url: string, approvals: WebhookApprovals | undefined): boolean {
  if (!approvals) return false;
  return approvals.urls.includes(hashWebhookUrl(url));
}
