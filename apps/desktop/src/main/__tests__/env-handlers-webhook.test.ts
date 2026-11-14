import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
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
vi.mock('../project-initializer', () => ({ isAutoBuildEnvTrackedByGit: vi.fn(() => false) }));

import { ipcMain } from 'electron';
import { registerEnvHandlers } from '../ipc-handlers/env-handlers';
import { IPC_CHANNELS } from '../../shared/constants';

type Res = { success: boolean; error?: string; data?: Record<string, unknown> };
const invoke = (channel: string, ...args: unknown[]) =>
  (ipcMain as never as { invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<Res> }).invokeHandler(
    channel,
    {},
    ...args
  );

let root: string;
let envPath: string;
const URL_OK = 'https://hooks.example.com/services/ABC';

describe('ENV_UPDATE / ENV_GET webhook keys', () => {
  beforeAll(() => {
    registerEnvHandlers((() => null) as never);
  });
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'env-webhook-'));
    mkdirSync(path.join(root, '.auto-claude'));
    envPath = path.join(root, '.auto-claude', '.env');
    store.project = { id: 'p1', path: root, autoBuildPath: '.auto-claude' };
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
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
});
