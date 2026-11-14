import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Project } from '../../../../shared/types';
import { IPC_CHANNELS } from '../../../../shared/constants';
import type { BrowserWindow } from 'electron';
import type { AgentManager } from '../../../agent/agent-manager';

const mockIpcMain = vi.hoisted(() => {
  const handlers = new Map<string, Function>();
  return {
    handlers,
    handle(channel: string, handler: Function): void {
      handlers.set(channel, handler);
    },
    on: vi.fn(),
    async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No handler for channel: ${channel}`);
      return handler({}, ...args);
    },
  };
});

const mockClasses = vi.hoisted(() => ({
  MockBrowserWindow: class MockBrowserWindow {},
  MockAgentManager: class MockAgentManager {},
  MockBatchProcessor: class MockBatchProcessor {},
}));

const projectRef: { current: Project | null } = { current: null };
const tempDirs: string[] = [];
const mockGithubFetch = vi.fn();

vi.mock('electron', () => ({
  ipcMain: mockIpcMain,
  BrowserWindow: mockClasses.MockBrowserWindow,
  app: { getPath: vi.fn(() => '/tmp'), on: vi.fn() },
}));

vi.mock('../utils/project-middleware', () => ({
  withProjectOrNull: async (_id: string, handler: (project: Project) => Promise<unknown>) =>
    projectRef.current ? handler(projectRef.current) : null,
}));

vi.mock('../utils', () => ({
  getGitHubConfig: vi.fn(() => ({ token: 'tok', repo: 'owner/repo' })),
  githubFetch: (...args: unknown[]) => mockGithubFetch(...args),
}));

vi.mock('../spec-utils', () => ({
  createSpecForIssue: vi.fn(),
  buildIssueContext: vi.fn(),
  buildInvestigationTask: vi.fn(),
  updateImplementationPlanStatus: vi.fn(),
}));

vi.mock('../../shared/ipc-communicator', () => ({
  createIPCCommunicators: () => ({ sendProgress: vi.fn(), sendComplete: vi.fn(), sendError: vi.fn() }),
}));

vi.mock('../../../agent/agent-manager', () => ({ AgentManager: mockClasses.MockAgentManager }));

vi.mock('../../../ai/runners/github/batch-processor', () => ({
  BatchProcessor: mockClasses.MockBatchProcessor,
  safeBatchId: (raw: unknown) => raw as string,
}));

vi.mock('../../../ai/runners/github/duplicate-detector', () => ({}));

import { registerAutoFixHandlers } from '../autofix-handlers';

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data), 'utf-8');
}

describe('GitHub autofix handlers', () => {
  let ghDir: string;

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-autofix-'));
    tempDirs.push(dir);
    projectRef.current = { id: 'p1', name: 'p', path: dir } as Project;
    ghDir = path.join(dir, '.auto-claude', 'github');
    mockIpcMain.handlers.clear();
    mockGithubFetch.mockReset();
    registerAutoFixHandlers({} as AgentManager, () => null as BrowserWindow | null);
  });

  afterEach(() => {
    projectRef.current = null;
    for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  const enable = (labels = ['auto-fix']) =>
    mockIpcMain.invoke(IPC_CHANNELS.GITHUB_AUTOFIX_SAVE_CONFIG, 'p1', {
      enabled: true,
      labels,
      requireHumanApproval: true,
      model: 'm',
      thinkingLevel: 'low',
    });

  it('returns defaults, then saved values including botToken', async () => {
    expect(await mockIpcMain.invoke(IPC_CHANNELS.GITHUB_AUTOFIX_GET_CONFIG, 'p1')).toMatchObject({
      enabled: false,
      labels: ['auto-fix'],
      requireHumanApproval: true,
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'medium',
    });

    const config = {
      enabled: true,
      labels: ['bug'],
      requireHumanApproval: false,
      botToken: 'bot-secret',
      model: 'x',
      thinkingLevel: 'high',
    };
    expect(await mockIpcMain.invoke(IPC_CHANNELS.GITHUB_AUTOFIX_SAVE_CONFIG, 'p1', config)).toBe(true);
    expect(await mockIpcMain.invoke(IPC_CHANNELS.GITHUB_AUTOFIX_GET_CONFIG, 'p1')).toEqual(config);

    const raw = JSON.parse(fs.readFileSync(path.join(ghDir, 'config.json'), 'utf-8'));
    expect(raw.bot_token).toBe('bot-secret');
    expect(raw.auto_fix_enabled).toBe(true);
  });

  it('reads the queue from snake_case files', async () => {
    writeJson(path.join(ghDir, 'issues', 'autofix_1.json'), {
      issue_number: 1, repo: 'owner/repo', status: 'building', spec_id: '001',
      created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-02T00:00:00Z',
    });
    writeJson(path.join(ghDir, 'issues', 'autofix_2.json'), {
      issue_number: 2, repo: 'owner/repo', status: 'failed', error: 'boom', pr_number: 9,
      created_at: '2024-02-01T00:00:00Z', updated_at: '2024-02-02T00:00:00Z',
    });
    const queue = (await mockIpcMain.invoke(IPC_CHANNELS.GITHUB_AUTOFIX_GET_QUEUE, 'p1')) as Array<Record<string, unknown>>;
    expect(queue.map(q => q.issueNumber)).toEqual([2, 1]);
    expect(queue[0]).toMatchObject({ status: 'failed', error: 'boom', prNumber: 9 });
    expect(queue[1]).toMatchObject({ specId: '001', repo: 'owner/repo' });
  });

  it('CHECK_LABELS skips queued issues, pull requests and unmatched labels', async () => {
    await enable();
    writeJson(path.join(ghDir, 'issues', 'autofix_1.json'), {
      issue_number: 1, repo: 'r', status: 'building', created_at: '2024-01-01T00:00:00Z', updated_at: '',
    });
    mockGithubFetch.mockResolvedValue([
      { number: 1, labels: [{ name: 'auto-fix' }] },
      { number: 2, labels: [{ name: 'Auto-Fix' }], pull_request: {} },
      { number: 3, labels: [{ name: 'other' }] },
      { number: 4, labels: [{ name: 'AUTO-FIX' }] },
    ]);
    expect(await mockIpcMain.invoke(IPC_CHANNELS.GITHUB_AUTOFIX_CHECK_LABELS, 'p1')).toEqual([4]);
  });

  it('CHECK_NEW excludes queued issues', async () => {
    await enable();
    writeJson(path.join(ghDir, 'issues', 'autofix_1.json'), {
      issue_number: 1, repo: 'r', status: 'building', created_at: '2024-01-01T00:00:00Z', updated_at: '',
    });
    mockGithubFetch.mockResolvedValue([{ number: 1 }, { number: 2 }, { number: 3, pull_request: {} }]);
    expect(await mockIpcMain.invoke(IPC_CHANNELS.GITHUB_AUTOFIX_CHECK_NEW, 'p1')).toEqual([{ number: 2 }]);
  });

  it('GET_BATCHES returns newest first', async () => {
    const batch = (id: string, created: string) => ({
      batch_id: id, repo: 'r', primary_issue: 1,
      issues: [{ issue_number: 1, title: 't', similarity_to_primary: 0.5 }],
      common_themes: ['x'], status: 'pending', created_at: created, updated_at: created,
    });
    writeJson(path.join(ghDir, 'batches', 'batch_a.json'), batch('a', '2024-01-01T00:00:00Z'));
    writeJson(path.join(ghDir, 'batches', 'batch_b.json'), batch('b', '2024-03-01T00:00:00Z'));
    const batches = (await mockIpcMain.invoke(IPC_CHANNELS.GITHUB_AUTOFIX_GET_BATCHES, 'p1')) as Array<Record<string, unknown>>;
    expect(batches.map(b => b.batchId)).toEqual(['b', 'a']);
    expect(batches[0].issues).toEqual([{ issueNumber: 1, title: 't', similarityToPrimary: 0.5 }]);
  });

  it('APPROVE_BATCHES writes batch files and returns mapped batches', async () => {
    const result = (await mockIpcMain.invoke(IPC_CHANNELS.GITHUB_AUTOFIX_APPROVE_BATCHES, 'p1', [
      {
        batchId: 'batch-x', primaryIssue: 5, commonThemes: ['theme'],
        issues: [{ issueNumber: 5, title: 'Five', similarityToPrimary: 0.9 }],
      },
    ])) as { success: boolean; batches: Array<Record<string, unknown>> };

    const written = JSON.parse(fs.readFileSync(path.join(ghDir, 'batches', 'batch_batch-x.json'), 'utf-8'));
    expect(written).toMatchObject({ batch_id: 'batch-x', repo: 'owner/repo', primary_issue: 5, status: 'pending' });
    expect(result.success).toBe(true);
    expect(result.batches).toHaveLength(1);
    expect(result.batches[0]).toMatchObject({
      batchId: 'batch-x',
      primaryIssue: 5,
      commonThemes: ['theme'],
      issues: [{ issueNumber: 5, title: 'Five', similarityToPrimary: 0.9 }],
    });
  });
});
