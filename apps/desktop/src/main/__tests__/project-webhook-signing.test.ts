import { describe, expect, it } from 'vitest';
import {
  describeProjectWebhookSigning,
  generateProjectWebhookSecret,
  type ProjectWebhookSigningRecord,
  resolveProjectWebhookSigning
} from '../project-webhook-signing';

const urlHash = 'current-url-hash';
const createdAt = '2026-01-01T00:00:00.000Z';
const signed: ProjectWebhookSigningRecord = { urlHash, mode: 'signed', secret: 'project-test-key', createdAt };
const unsigned: ProjectWebhookSigningRecord = { urlHash, mode: 'unsigned', secret: '', createdAt };
const unavailable = { ...signed, secret: '' };
const staleSigned = { ...signed, urlHash: 'old-url-hash' };
const staleUnsigned = { ...unsigned, urlHash: 'old-url-hash' };

const sendSigned = { action: 'send', secret: signed.secret };
const sendUnsigned = { action: 'send', secret: '' };
const withholdUnavailable = { action: 'withhold', reason: 'secret_unavailable' };
const withholdChoiceRequired = { action: 'withhold', reason: 'signing_choice_required' };

describe('generateProjectWebhookSecret', () => {
  it('generates independent 64-character lowercase hex secrets', () => {
    const first = generateProjectWebhookSecret();
    const second = generateProjectWebhookSecret();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
  });
});

describe('project webhook signing decisions and status', () => {
  it.each([false, true])('honors a matching record with appSecretSet=%s', (appSecretSet) => {
    const cases = [
      { record: signed, decision: sendSigned, status: 'signed' },
      { record: unavailable, decision: withholdUnavailable, status: 'secret_unavailable' },
      { record: unsigned, decision: sendUnsigned, status: 'unsigned' }
    ];
    for (const { record, decision, status } of cases) {
      const input = { record, urlHash, appSecretSet };
      expect(resolveProjectWebhookSigning(input)).toStrictEqual(decision);
      expect(describeProjectWebhookSigning(input)).toStrictEqual({ status, createdAt });
    }
  });

  it.each([false, true])('withholds for a stale signed record with appSecretSet=%s', (appSecretSet) => {
    const input = { record: staleSigned, urlHash, appSecretSet };
    expect(resolveProjectWebhookSigning(input)).toStrictEqual(withholdChoiceRequired);
    expect(describeProjectWebhookSigning(input)).toStrictEqual({ status: 'choice_required' });
  });

  it.each([false, true])('applies the migration rule with appSecretSet=%s', (appSecretSet) => {
    for (const record of [null, staleUnsigned]) {
      const input = { record, urlHash, appSecretSet };
      expect(resolveProjectWebhookSigning(input)).toStrictEqual(appSecretSet ? withholdChoiceRequired : sendUnsigned);
      expect(describeProjectWebhookSigning(input)).toStrictEqual({
        status: appSecretSet ? 'choice_required' : 'unsigned'
      });
    }
  });
});
