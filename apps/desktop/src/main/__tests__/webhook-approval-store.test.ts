import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.dir } }));

import { approveWebhookUrlHash, getWebhookApprovals, removeWebhookUrlApproval } from '../webhook-approval-store';

beforeEach(() => {
  state.dir = mkdtempSync(join(tmpdir(), 'webhook-approval-store-'));
});
afterEach(() => rmSync(state.dir, { recursive: true, force: true }));

describe('webhook-approval-store', () => {
  it('returns nothing approved when no file exists', () => {
    expect(getWebhookApprovals('/p')).toEqual({ urls: [] });
  });

  it('round-trips approvals, deduped, and removes them', () => {
    approveWebhookUrlHash('/p', 'h1');
    approveWebhookUrlHash('/p', 'h1');
    approveWebhookUrlHash('/p', 'h2');
    expect(getWebhookApprovals('/p')).toEqual({ urls: ['h1', 'h2'] });

    removeWebhookUrlApproval('/p', 'h1');
    expect(getWebhookApprovals('/p')).toEqual({ urls: ['h2'] });
    expect(readdirSync(state.dir)).toEqual(['webhook-approvals.json']); // no temp file left
  });

  it('treats a corrupt file as nothing approved and recovers on write', () => {
    writeFileSync(join(state.dir, 'webhook-approvals.json'), '{not json');
    expect(getWebhookApprovals('/p')).toEqual({ urls: [] });
    approveWebhookUrlHash('/p', 'h1');
    expect(getWebhookApprovals('/p').urls).toEqual(['h1']);
  });

  it('isolates projects and normalises paths', () => {
    approveWebhookUrlHash('/a/b/../c/', 'h1');
    expect(getWebhookApprovals('/a/c').urls).toEqual(['h1']);
    expect(getWebhookApprovals('/other').urls).toEqual([]);
  });
});
