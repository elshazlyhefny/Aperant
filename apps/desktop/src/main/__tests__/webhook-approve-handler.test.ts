import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const store = vi.hoisted(() => ({ project: null as null | { id: string; path: string; autoBuildPath: string } }));
vi.mock('../project-store', () => ({ projectStore: { getProject: () => store.project } }));
const approvals = vi.hoisted(() => ({ approveWebhookUrlHash: vi.fn(), getWebhookApprovals: vi.fn(() => ({ urls: [] })) }));
vi.mock('../webhook-approval-store', () => approvals);
vi.mock('../mcp-approval-store', () => ({ approveChromeExecutable: vi.fn(), approveServer: vi.fn(), getApprovals: vi.fn(() => ({})) }));
vi.mock('../ai/mcp/project-settings', () => ({
  describeProjectMcpTrust: vi.fn(() => ({ servers: [], chromeExecutable: undefined })),
  parseSecureOrigins: vi.fn(() => [])
}));
vi.mock('../project-initializer', () => ({ isAutoBuildEnvTrackedByGit: vi.fn(() => false) }));

import { approveProjectWebhookIfUnchanged } from '../ipc-handlers/env-handlers';
import { hashWebhookUrl } from '../project-webhook-approval';

const URL_OK = 'https://hooks.example.com/services/ABC';
let root: string;
let envPath: string;

describe('approveProjectWebhookIfUnchanged', () => {
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'webhook-appr-'));
    mkdirSync(path.join(root, '.auto-claude'));
    envPath = path.join(root, '.auto-claude', '.env');
    store.project = { id: 'p1', path: root, autoBuildPath: '.auto-claude' };
    vi.clearAllMocks();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('approves when the hash matches', () => {
    writeFileSync(envPath, `WEBHOOK_URL=${URL_OK}\n`);
    expect(approveProjectWebhookIfUnchanged('p1', hashWebhookUrl(URL_OK))).toEqual({ success: true });
    expect(approvals.approveWebhookUrlHash).toHaveBeenCalledWith(root, hashWebhookUrl(URL_OK));
  });

  it('refuses when the file changed since shown', () => {
    writeFileSync(envPath, `WEBHOOK_URL=${URL_OK}\n`);
    const shown = hashWebhookUrl(URL_OK);
    writeFileSync(envPath, 'WEBHOOK_URL=https://other.example.com/y\n');
    const res = approveProjectWebhookIfUnchanged('p1', shown);
    expect(res.success).toBe(false);
    expect(res.error).toContain('changed');
    expect(approvals.approveWebhookUrlHash).not.toHaveBeenCalled();
  });

  it('refuses a loopback URL even with a matching hash', () => {
    const bad = 'https://localhost/x';
    writeFileSync(envPath, `WEBHOOK_URL=${bad}\n`);
    expect(approveProjectWebhookIfUnchanged('p1', hashWebhookUrl(bad)).success).toBe(false);
    expect(approvals.approveWebhookUrlHash).not.toHaveBeenCalled();
  });

  it('refuses an unknown project', () => {
    store.project = null;
    expect(approveProjectWebhookIfUnchanged('p1', 'x')).toEqual({ success: false, error: 'Project not found' });
  });
});
