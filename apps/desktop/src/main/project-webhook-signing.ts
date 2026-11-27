/**
 * zeenha fork: use one signing key per webhook destination (OWASP A04).
 * A project receiver's key must not authenticate deliveries to another
 * receiver. This module resolves signing without accessing credential storage.
 */

import { randomBytes } from 'node:crypto';

export type ProjectWebhookSigningRecord = {
  urlHash: string;
  mode: 'signed' | 'unsigned';
  /** Decrypted secret, or '' when decryption failed or the record is unsigned. */
  secret: string;
  createdAt: string;
};

export type ProjectWebhookSigningDecision =
  | { action: 'send'; secret: string }
  | { action: 'withhold'; reason: 'secret_unavailable' | 'signing_choice_required' };

export type ProjectWebhookSigningStatus = 'signed' | 'unsigned' | 'choice_required' | 'secret_unavailable';

type ProjectWebhookSigningInput = {
  record: ProjectWebhookSigningRecord | null;
  urlHash: string;
  appSecretSet: boolean;
};

export function generateProjectWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

export function resolveProjectWebhookSigning({
  record,
  urlHash,
  appSecretSet
}: ProjectWebhookSigningInput): ProjectWebhookSigningDecision {
  if (record && record.urlHash === urlHash) {
    if (record.mode === 'unsigned') return { action: 'send', secret: '' };
    if (record.secret) return { action: 'send', secret: record.secret };
    return { action: 'withhold', reason: 'secret_unavailable' };
  }

  // A changed URL cannot inherit a key, and a previously signed delivery must
  // not silently become unsigned (including when it used the app-wide key).
  if (record?.mode === 'signed' || appSecretSet) {
    return { action: 'withhold', reason: 'signing_choice_required' };
  }
  return { action: 'send', secret: '' };
}

export function describeProjectWebhookSigning(
  input: ProjectWebhookSigningInput
): { status: ProjectWebhookSigningStatus; createdAt?: string } {
  const decision = resolveProjectWebhookSigning(input);
  let status: ProjectWebhookSigningStatus;
  if (decision.action === 'send') {
    status = decision.secret ? 'signed' : 'unsigned';
  } else {
    status = decision.reason === 'signing_choice_required' ? 'choice_required' : 'secret_unavailable';
  }

  const { record, urlHash } = input;
  return record && record.urlHash === urlHash ? { status, createdAt: record.createdAt } : { status };
}
