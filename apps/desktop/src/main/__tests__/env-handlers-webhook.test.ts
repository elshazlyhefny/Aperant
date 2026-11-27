import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const store = vi.hoisted(() => ({ project: null as null | { id: string; path: string; autoBuildPath: string } }));
vi.mock('../project-store', () => ({ projectStore: { getProject: () => store.project } }));
vi.mock('../mcp-approval-store', () => ({
  approveChromeExecutable: vi.fn(),
  approveServer: vi.fn(),
  getApprovals: vi.fn(() => ({}))
}));
vi.mock('../ai/mcp/project-settings', () => ({
  describeProjectMcpTrust: vi.fn(() => ({ servers: [], chromeExecutable: undefined })),
  parseSecureOrigins: vi.fn(() => [])
}));
const approvalMocks = vi.hoisted(() => ({
  approveWebhookUrlHash: vi.fn(),
  getWebhookApprovals: vi.fn(() => ({ urls: [] as string[] }))
}));
vi.mock('../webhook-approval-store', () => approvalMocks);
vi.mock('../project-initializer', () => ({ isAutoBuildEnvTrackedByGit: vi.fn(() => false) }));

import { app, ipcMain } from 'electron';
import { wrapEnvelope } from '../../shared/utils/secret-envelope';
import { registerEnvHandlers } from '../ipc-handlers/env-handlers';
import { IPC_CHANNELS } from '../../shared/constants';
import { hashWebhookUrl } from '../project-webhook-approval';

type Res = { success: boolean; error?: string; data?: Record<string, unknown> };
const invoke = (channel: string, ...args: unknown[]) =>
  (ipcMain as never as { invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<Res> }).invokeHandler(
    channel,
    {},
    ...args
  );

let userData: string;
let root: string;
let envPath: string;
const URL_OK = 'https://hooks.example.com/services/ABC';

describe('ENV_UPDATE / ENV_GET webhook keys', () => {
  beforeAll(() => {
    userData = mkdtempSync(path.join(tmpdir(), 'env-user-data-'));
    vi.mocked(app.getPath).mockReturnValueOnce(userData);
    registerEnvHandlers((() => null) as never);
  });
  afterAll(() => {
    rmSync(userData, { recursive: true, force: true });
  });
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'env-webhook-'));
    mkdirSync(path.join(root, '.auto-claude'));
    envPath = path.join(root, '.auto-claude', '.env');
    store.project = { id: 'p1', path: root, autoBuildPath: '.auto-claude' };
  });
  afterEach(() => {
    vi.clearAllMocks();
    approvalMocks.getWebhookApprovals.mockReturnValue({ urls: [] });
    rmSync(root, { recursive: true, force: true });
    rmSync(path.join(userData, 'settings.json'), { force: true });
  });

  it('reports an inherited OpenAI key without returning its stored value', async () => {
    const storedKey = wrapEnvelope(Buffer.from('mock-ciphertext').toString('base64'));
    writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ globalOpenAIApiKey: storedKey }));

    const inherited = await invoke(IPC_CHANNELS.ENV_GET, 'p1');
    expect(inherited.success).toBe(true);
    expect(inherited.data?.openaiKeyIsGlobal).toBe(true);
    expect(inherited.data).not.toHaveProperty('openaiApiKey');

    writeFileSync(envPath, 'OPENAI_API_KEY=test-project-key\n');
    const overridden = await invoke(IPC_CHANNELS.ENV_GET, 'p1');
    expect(overridden.data?.openaiKeyIsGlobal).toBe(false);
    expect(overridden.data?.openaiApiKey).toBe('test-project-key');
  });

  it('writes the keys with mode 0600 and round-trips via ENV_GET', async () => {
    const res = await invoke(IPC_CHANNELS.ENV_UPDATE, 'p1', {
      webhookEnabled: true,
      webhookUrl: `  ${URL_OK} `,
      webhookEvents: { reviewReady: false, failed: true, blocked: true, prOpened: true }
    });
    expect(res.success).toBe(true);
    const content = readFileSync(envPath, 'utf-8');
    expect(content).toContain(`WEBHOOK_URL=${URL_OK}\n`);
    expect(content).toContain('WEBHOOK_ENABLED=true');
    expect(content).toContain('WEBHOOK_EVENT_REVIEW_READY=false');
    expect(content).toContain('WEBHOOK_EVENT_PR_OPENED=true');
    if (process.platform !== 'win32') expect(statSync(envPath).mode & 0o777).toBe(0o600);

    const got = await invoke(IPC_CHANNELS.ENV_GET, 'p1');
    expect(got.data?.webhookUrl).toBe(URL_OK);
    expect(got.data?.webhookEnabled).toBe(true);
    expect(got.data?.webhookEvents).toEqual({ reviewReady: false, failed: true, blocked: true, prOpened: true });
  });

  it('round-trips the webhook format, removes it on auto, ignores invalid values', async () => {
    await invoke(IPC_CHANNELS.ENV_UPDATE, 'p1', { webhookEnabled: true, webhookUrl: URL_OK, webhookFormat: 'teams' });
    expect(readFileSync(envPath, 'utf-8')).toMatch(/^WEBHOOK_FORMAT=teams$/m);
    let got = await invoke(IPC_CHANNELS.ENV_GET, 'p1');
    expect(got.data?.webhookFormat).toBe('teams');

    await invoke(IPC_CHANNELS.ENV_UPDATE, 'p1', { webhookFormat: 'bogus' as never });
    expect(readFileSync(envPath, 'utf-8')).toMatch(/^WEBHOOK_FORMAT=teams$/m);

    await invoke(IPC_CHANNELS.ENV_UPDATE, 'p1', { webhookFormat: 'auto' });
    expect(readFileSync(envPath, 'utf-8')).not.toMatch(/^WEBHOOK_FORMAT=/m);
    expect(readFileSync(envPath, 'utf-8')).toContain('# WEBHOOK_FORMAT=slack|teams|discord');
    got = await invoke(IPC_CHANNELS.ENV_GET, 'p1');
    expect(got.data?.webhookFormat).toBe('auto');
  });

  it('clearing the URL removes WEBHOOK_FORMAT', async () => {
    await invoke(IPC_CHANNELS.ENV_UPDATE, 'p1', { webhookEnabled: true, webhookUrl: URL_OK, webhookFormat: 'discord' });
    await invoke(IPC_CHANNELS.ENV_UPDATE, 'p1', { webhookUrl: '' });
    expect(readFileSync(envPath, 'utf-8')).not.toMatch(/^WEBHOOK_FORMAT=/m);
  });

  it('changing only the format does not change the approval hash or status', async () => {
    approvalMocks.getWebhookApprovals.mockReturnValue({ urls: [hashWebhookUrl(URL_OK)] });
    await invoke(IPC_CHANNELS.ENV_UPDATE, 'p1', { webhookEnabled: true, webhookUrl: URL_OK, webhookFormat: 'slack' });
    const a = await invoke(IPC_CHANNELS.ENV_GET, 'p1');
    await invoke(IPC_CHANNELS.ENV_UPDATE, 'p1', { webhookFormat: 'teams' });
    const b = await invoke(IPC_CHANNELS.ENV_GET, 'p1');
    expect(b.data?.webhookApproval).toEqual(a.data?.webhookApproval);
    expect((b.data?.webhookApproval as { status: string }).status).toBe('approved');
  });

  it('rejects an invalid URL without writing', async () => {
    writeFileSync(envPath, 'FOO=bar\n');
    for (const bad of ['http://evil.example.com/x', 'https://u:p@h.example.com/x', 'not a url', 'https://a.example.com/x\nEVIL=1']) {
      const res = await invoke(IPC_CHANNELS.ENV_UPDATE, 'p1', { webhookEnabled: true, webhookUrl: bad });
      expect(res).toEqual({ success: false, error: 'invalid_webhook_url' });
    }
    expect(readFileSync(envPath, 'utf-8')).toBe('FOO=bar\n');
  });

  it('clears the keys when the URL is empty', async () => {
    await invoke(IPC_CHANNELS.ENV_UPDATE, 'p1', { webhookEnabled: true, webhookUrl: URL_OK });
    const res = await invoke(IPC_CHANNELS.ENV_UPDATE, 'p1', { webhookUrl: '' });
    expect(res.success).toBe(true);
    expect(readFileSync(envPath, 'utf-8')).not.toMatch(/^WEBHOOK_URL=/m);
    const got = await invoke(IPC_CHANNELS.ENV_GET, 'p1');
    expect(got.data?.webhookUrl).toBeUndefined();
  });

  it('preserves unrelated keys and webhook keys across other saves', async () => {
    writeFileSync(envPath, 'JIRA_API_TOKEN=secret-token\n');
    await invoke(IPC_CHANNELS.ENV_UPDATE, 'p1', { webhookEnabled: true, webhookUrl: URL_OK });
    await invoke(IPC_CHANNELS.ENV_UPDATE, 'p1', { defaultBranch: 'main' });
    const content = readFileSync(envPath, 'utf-8');
    expect(content).toContain('JIRA_API_TOKEN=secret-token');
    expect(content).toContain(`WEBHOOK_URL=${URL_OK}`);
    expect(content).toContain('# PROJECT TASK-OUTCOME WEBHOOK (OPTIONAL)');
  });

  it('rejects a loopback URL typed on the page', async () => {
    writeFileSync(envPath, 'FOO=bar\n');
    const res = await invoke(IPC_CHANNELS.ENV_UPDATE, 'p1', { webhookEnabled: true, webhookUrl: 'https://localhost/x' });
    expect(res).toEqual({ success: false, error: 'invalid_webhook_url' });
    expect(readFileSync(envPath, 'utf-8')).toBe('FOO=bar\n');
    expect(approvalMocks.approveWebhookUrlHash).not.toHaveBeenCalled();
  });

  it('does not approve or block on a pre-existing committed URL during an unrelated save', async () => {
    writeFileSync(envPath, 'WEBHOOK_URL=https://localhost/x\nWEBHOOK_ENABLED=true\n');
    const res = await invoke(IPC_CHANNELS.ENV_UPDATE, 'p1', { webhookEnabled: true, webhookUrl: 'https://localhost/x', defaultBranch: 'main' });
    expect(res.success).toBe(true);
    writeFileSync(envPath, `WEBHOOK_URL=${URL_OK}\n`);
    const res2 = await invoke(IPC_CHANNELS.ENV_UPDATE, 'p1', { defaultBranch: 'dev' });
    expect(res2.success).toBe(true);
    expect(approvalMocks.approveWebhookUrlHash).not.toHaveBeenCalled();
  });

  it('approves a newly typed URL', async () => {
    const res = await invoke(IPC_CHANNELS.ENV_UPDATE, 'p1', { webhookEnabled: true, webhookUrl: URL_OK });
    expect(res.success).toBe(true);
    expect(approvalMocks.approveWebhookUrlHash).toHaveBeenCalledWith(root, hashWebhookUrl(URL_OK));
  });

  it('ENV_GET reports unapproved, approved and refused', async () => {
    writeFileSync(envPath, `WEBHOOK_URL=${URL_OK}\n`);
    let got = await invoke(IPC_CHANNELS.ENV_GET, 'p1');
    expect(got.data?.webhookApproval).toMatchObject({ status: 'unapproved', hash: hashWebhookUrl(URL_OK) });
    approvalMocks.getWebhookApprovals.mockReturnValue({ urls: [hashWebhookUrl(URL_OK)] });
    got = await invoke(IPC_CHANNELS.ENV_GET, 'p1');
    expect((got.data?.webhookApproval as { status: string }).status).toBe('approved');
    writeFileSync(envPath, 'WEBHOOK_URL=https://localhost/x\n');
    got = await invoke(IPC_CHANNELS.ENV_GET, 'p1');
    expect((got.data?.webhookApproval as { status: string }).status).toBe('refused');
  });
});
