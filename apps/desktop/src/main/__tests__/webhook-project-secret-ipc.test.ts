import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ipcMain } from 'electron';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../shared/constants';
import { registerEnvHandlers } from '../ipc-handlers/env-handlers';
import { hashWebhookUrl } from '../project-webhook-approval';
import { generateProjectWebhookSecret, type ProjectWebhookSigningRecord } from '../project-webhook-signing';
import { verifyWebhookSignature, WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TIMESTAMP_HEADER } from '../task-webhook-core';

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }));
const mocks = vi.hoisted(() => ({
  project: null as { id: string; path: string; autoBuildPath: string } | null,
  approved: [] as string[],
  record: null as ProjectWebhookSigningRecord | null,
  createProjectWebhookSecret: vi.fn<(projectPath: string, hash: string) => string>(),
  setProjectWebhookUnsigned: vi.fn<(projectPath: string, hash: string) => void>(),
  readSettingsFile: vi.fn()
}));
vi.mock('../project-store', () => ({ projectStore: { getProject: (id: string) => mocks.project?.id === id ? mocks.project : undefined } }));
vi.mock('../webhook-approval-store', () => ({ approveWebhookUrlHash: vi.fn(), getWebhookApprovals: () => ({ urls: mocks.approved }) }));
vi.mock('../webhook-secret-store', () => ({
  getProjectWebhookSigningRecord: () => mocks.record,
  createProjectWebhookSecret: mocks.createProjectWebhookSecret,
  setProjectWebhookUnsigned: mocks.setProjectWebhookUnsigned
}));
vi.mock('../settings-utils', () => ({ readSettingsFile: mocks.readSettingsFile }));
vi.mock('../mcp-approval-store', () => ({ approveChromeExecutable: vi.fn(), approveServer: vi.fn(), getApprovals: vi.fn() }));
vi.mock('../ai/mcp/project-settings', () => ({
  describeProjectMcpTrust: () => ({ servers: [] }),
  parseSecureOrigins: () => []
}));
vi.mock('../project-initializer', () => ({ isAutoBuildEnvTrackedByGit: () => false }));

const DEV_URL = 'http://localhost:5173';
const URL = 'https://hooks.example.com/project';
const HASH = hashWebhookUrl(URL);
const CHANGED_URL = 'https://hooks.example.com/changed';
const LOOPBACK = 'https://localhost/project';
const APP_SECRET = 'app-wide-test-key';
const PROJECT_SECRET = 'project-test-key';
const CREATED_AT = '2026-11-27T12:00:00.000Z';
const GENERATE = IPC_CHANNELS.WEBHOOK_PROJECT_SECRET_GENERATE;
const UNSIGNED = IPC_CHANNELS.WEBHOOK_PROJECT_SIGNING_UNSIGNED;
const SEND_TEST = IPC_CHANNELS.WEBHOOK_PROJECT_SEND_TEST;
const fetchMock = vi.fn<typeof fetch>();
let root: string;
let envPath: string;

const ipc = ipcMain as unknown as {
  invokeHandler: (channel: string, event: unknown, ...args: unknown[]) => Promise<unknown>;
};
const invoke = (channel: string, ...args: unknown[]) =>
  ipc.invokeHandler(channel, { senderFrame: { url: DEV_URL } }, 'p1', ...args);

function declareWebhook(url: string): void {
  writeFileSync(envPath, `WEBHOOK_URL=${url}\nWEBHOOK_FORMAT=discord\nWEBHOOK_SECRET=repository-test-key\n`);
}

function lastDelivery() {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe(URL);
  return { headers: new Headers(init?.headers), body: String(init?.body) };
}

describe('project webhook signing IPC', () => {
  beforeAll(() => registerEnvHandlers(() => null));

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'webhook-signing-ipc-'));
    mkdirSync(path.join(root, '.auto-claude'));
    envPath = path.join(root, '.auto-claude', '.env');
    declareWebhook(URL);
    mocks.project = { id: 'p1', path: root, autoBuildPath: '.auto-claude' };
    mocks.approved = [HASH];
    mocks.record = null;
    mocks.readSettingsFile.mockReset().mockReturnValue({ webhook: { secret: APP_SECRET } });
    mocks.createProjectWebhookSecret.mockReset().mockImplementation((_projectPath, urlHash) => {
      const secret = generateProjectWebhookSecret();
      mocks.record = { urlHash, mode: 'signed', secret, createdAt: CREATED_AT };
      return secret;
    });
    mocks.setProjectWebhookUnsigned.mockReset().mockImplementation((_projectPath, urlHash) => {
      mocks.record = { urlHash, mode: 'unsigned', secret: '', createdAt: CREATED_AT };
    });
    fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('ELECTRON_RENDERER_URL', DEV_URL);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('generates and rotates a 64-hex secret for the current approved hash', async () => {
    const initial = await invoke(GENERATE, HASH);
    expect(initial).toEqual({ success: true, data: { secret: expect.stringMatching(/^[0-9a-f]{64}$/), createdAt: CREATED_AT } });
    const rotated = await invoke(GENERATE, HASH);
    expect(rotated).toEqual({ success: true, data: { secret: mocks.record?.secret, createdAt: CREATED_AT } });
    expect(rotated).not.toEqual(initial);
    expect(mocks.createProjectWebhookSecret.mock.calls).toEqual([[root, HASH], [root, HASH]]);
  });

  it.each([
    { what: 'changed URL, even if approved separately', url: CHANGED_URL, approved: [HASH, hashWebhookUrl(CHANGED_URL)], shown: HASH },
    { what: 'unapproved URL', url: URL, approved: [], shown: HASH },
    { what: 'refused loopback URL', url: LOOPBACK, approved: [hashWebhookUrl(LOOPBACK)], shown: hashWebhookUrl(LOOPBACK) }
  ])('refuses signing actions and test sends for a $what', async ({ url, approved, shown }) => {
    declareWebhook(url);
    mocks.approved = approved;
    for (const channel of [GENERATE, UNSIGNED, SEND_TEST]) {
      expect(await invoke(channel, shown)).toEqual({ success: false, error: expect.stringContaining('changed') });
    }
    expect(mocks.createProjectWebhookSecret).not.toHaveBeenCalled();
    expect(mocks.setProjectWebhookUnsigned).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows an explicit unsigned choice and sends a test without the app-wide key', async () => {
    expect(await invoke(UNSIGNED, HASH)).toEqual({ success: true });
    expect(mocks.setProjectWebhookUnsigned).toHaveBeenCalledWith(root, HASH);
    expect(await invoke(SEND_TEST, HASH)).toEqual({ success: true, data: { success: true } });
    const { headers, body } = lastDelivery();
    expect(headers.has(WEBHOOK_SIGNATURE_HEADER)).toBe(false);
    expect(headers.has(WEBHOOK_TIMESTAMP_HEADER)).toBe(false);
    expect(JSON.parse(body)).toHaveProperty('embeds'); // Uses the declared format when no override is supplied.
  });

  it('signs the project test with only the project key and accepts a valid format override', async () => {
    mocks.record = { urlHash: HASH, mode: 'signed', secret: PROJECT_SECRET, createdAt: CREATED_AT };
    expect(await invoke(SEND_TEST, HASH, 'slack')).toEqual({ success: true, data: { success: true } });
    const { headers, body } = lastDelivery();
    expect(JSON.parse(body)).toHaveProperty('blocks');
    const timestamp = headers.get(WEBHOOK_TIMESTAMP_HEADER) ?? '';
    const signature = headers.get(WEBHOOK_SIGNATURE_HEADER) ?? '';
    expect(verifyWebhookSignature(PROJECT_SECRET, timestamp, body, signature)).toBe(true);
    expect(verifyWebhookSignature(APP_SECRET, timestamp, body, signature)).toBe(false);
  });

  it('withholds the project test when an app-wide key is set and no project choice was made', async () => {
    expect(await invoke(SEND_TEST, HASH)).toEqual({ success: false, error: 'signing_choice_required' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('withholds the project test when the local secret cannot be decrypted', async () => {
    mocks.record = { urlHash: HASH, mode: 'signed', secret: '', createdAt: CREATED_AT };
    expect(await invoke(SEND_TEST, HASH)).toEqual({ success: false, error: 'secret_unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ENV_GET reports only signing metadata, never a secret', async () => {
    expect(await invoke(IPC_CHANNELS.ENV_GET)).toMatchObject({
      success: true, data: { webhookSigning: { status: 'choice_required' } }
    });
    mocks.record = { urlHash: HASH, mode: 'signed', secret: PROJECT_SECRET, createdAt: CREATED_AT };
    const config = await invoke(IPC_CHANNELS.ENV_GET);
    expect(config).toMatchObject({ success: true, data: { webhookSigning: { status: 'signed', createdAt: CREATED_AT } } });
    for (const secret of [PROJECT_SECRET, APP_SECRET, 'repository-test-key']) {
      expect(JSON.stringify(config)).not.toContain(secret);
    }
  });

  it('rejects untrusted renderers before mutating local signing or sending', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const channel of [GENERATE, UNSIGNED, SEND_TEST]) {
      const result = await ipc.invokeHandler(channel, { senderFrame: { url: 'https://external.example.com' } }, 'p1', HASH);
      expect(result).toEqual({ success: false, error: 'untrusted_sender' });
    }
    expect(mocks.createProjectWebhookSecret).not.toHaveBeenCalled();
    expect(mocks.setProjectWebhookUnsigned).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
