import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.dir } }));

import {
  approveChromeExecutable,
  approveServer,
  getApprovals,
  removeChromeExecutableApproval,
  removeServerApproval,
} from '../mcp-approval-store';

beforeEach(() => {
  state.dir = mkdtempSync(join(tmpdir(), 'mcp-approval-store-'));
});
afterEach(() => rmSync(state.dir, { recursive: true, force: true }));

describe('mcp-approval-store', () => {
  it('returns nothing approved when no file exists', () => {
    expect(getApprovals('/p')).toEqual({ servers: [], chromeExecutables: [] });
  });

  it('round-trips approvals, deduped, and removes them', () => {
    approveServer('/p', 'h1');
    approveServer('/p', 'h1');
    approveServer('/p', 'h2');
    approveChromeExecutable('/p', '/usr/bin/chrome');
    expect(getApprovals('/p')).toEqual({ servers: ['h1', 'h2'], chromeExecutables: ['/usr/bin/chrome'] });
    expect(getApprovals('/other').servers).toEqual([]);

    removeServerApproval('/p', 'h1');
    removeChromeExecutableApproval('/p', '/usr/bin/chrome');
    expect(getApprovals('/p')).toEqual({ servers: ['h2'], chromeExecutables: [] });
    expect(readdirSync(state.dir)).toEqual(['mcp-approvals.json']); // no temp file left
  });

  it('treats a corrupt file as nothing approved and recovers on write', () => {
    writeFileSync(join(state.dir, 'mcp-approvals.json'), '{not json');
    expect(getApprovals('/p')).toEqual({ servers: [], chromeExecutables: [] });
    approveServer('/p', 'h1');
    expect(getApprovals('/p').servers).toEqual(['h1']);
  });

  it('normalises project paths', () => {
    approveServer('/a/b/../c/', 'h1');
    expect(getApprovals('/a/c').servers).toEqual(['h1']);
  });
});
