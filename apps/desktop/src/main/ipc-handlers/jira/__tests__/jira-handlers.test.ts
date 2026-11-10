import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
const getProject = vi.fn();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, fn);
    },
  },
}));

vi.mock('../../../project-store', () => ({
  projectStore: { getProject: (...args: unknown[]) => getProject(...args) },
}));

import { registerJiraHandlers } from '../jira-handlers';
import { IPC_CHANNELS } from '../../../../shared/constants';

const SITE = 'https://acme.atlassian.net';
const TOKEN = 'SECRET-TOKEN-123';

function rawIssue(n: number, summary = `Issue ${n}`) {
  return {
    id: String(10000 + n),
    key: `PROJ-${n}`,
    fields: {
      summary,
      description: null,
      status: { name: 'To Do', statusCategory: { key: 'new' } },
      issuetype: { name: 'Task' },
      labels: [],
      created: '2026-01-01T00:00:00.000+0000',
      updated: '2026-01-02T00:00:00.000+0000',
    },
  };
}

describe('Jira IPC handlers', () => {
  let projectDir: string;
  let startSpecCreation: ReturnType<typeof vi.fn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  const call = <T>(channel: string, ...args: unknown[]) => handlers.get(channel)?.({}, ...args) as Promise<T>;

  const writeEnv = (content: string) => {
    mkdirSync(path.join(projectDir, '.auto-claude'), { recursive: true });
    writeFileSync(path.join(projectDir, '.auto-claude', '.env'), content, 'utf-8');
  };
  const configure = () =>
    writeEnv(`JIRA_SITE_URL=${SITE}\nJIRA_EMAIL=me@acme.com\nJIRA_API_TOKEN=${TOKEN}\nJIRA_PROJECT_KEY=PROJ\n`);

  const jsonResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

  beforeEach(() => {
    handlers.clear();
    projectDir = mkdtempSync(path.join(tmpdir(), 'jira-handlers-'));
    getProject.mockReturnValue({ id: 'p1', path: projectDir, autoBuildPath: '.auto-claude' });
    startSpecCreation = vi.fn();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    registerJiraHandlers({ startSpecCreation } as never, () => null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('returns connected false when not configured', async () => {
    const res = await call<{ success: boolean; data: { connected: boolean; error?: string } }>(
      IPC_CHANNELS.JIRA_CHECK_CONNECTION,
      'p1'
    );
    expect(res.success).toBe(true);
    expect(res.data.connected).toBe(false);
    expect(res.data.error).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns connected true on a successful check', async () => {
    configure();
    fetchMock.mockResolvedValue(jsonResponse({ displayName: 'Jane Doe' }));
    const res = await call<{ data: { connected: boolean; userName?: string; siteName?: string } }>(
      IPC_CHANNELS.JIRA_CHECK_CONNECTION,
      'p1'
    );
    expect(res.data.connected).toBe(true);
    expect(res.data.userName).toBe('Jane Doe');
    expect(res.data.siteName).toBe('acme.atlassian.net');
  });

  it('returns connected false with a message when Jira rejects the credentials', async () => {
    configure();
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    const res = await call<{ success: boolean; data: { connected: boolean; error?: string } }>(
      IPC_CHANNELS.JIRA_CHECK_CONNECTION,
      'p1'
    );
    expect(res.success).toBe(true);
    expect(res.data.connected).toBe(false);
    expect(res.data.error).not.toContain(TOKEN);
  });

  it('annotates issues that were already imported', async () => {
    configure();
    const specDir = path.join(projectDir, '.auto-claude', 'specs', '001-issue-1');
    mkdirSync(specDir, { recursive: true });
    writeFileSync(
      path.join(specDir, 'task_metadata.json'),
      JSON.stringify({ sourceType: 'jira', jiraIssueKey: 'PROJ-1', jiraSiteUrl: SITE }),
      'utf-8'
    );
    fetchMock.mockResolvedValue(jsonResponse({ issues: [rawIssue(1), rawIssue(2)] }));

    const res = await call<{
      success: boolean;
      data: { issues: Array<{ key: string; alreadyImported: boolean; existingSpecId?: string }> };
    }>(IPC_CHANNELS.JIRA_GET_ISSUES, 'p1', {});
    expect(res.success).toBe(true);
    const [first, second] = res.data.issues;
    expect(first.alreadyImported).toBe(true);
    expect(first.existingSpecId).toBe('001-issue-1');
    expect(second.alreadyImported).toBe(false);
  });

  it('skips duplicates on import and reports them', async () => {
    configure();
    fetchMock.mockResolvedValue(jsonResponse({ issues: [rawIssue(1)] }));

    const first = await call<{ data: { imported: number } }>(IPC_CHANNELS.JIRA_IMPORT_ISSUES, 'p1', ['PROJ-1']);
    expect(first.data.imported).toBe(1);

    const second = await call<{
      data: { imported: number; skipped: Array<{ key: string; specId: string }> };
    }>(IPC_CHANNELS.JIRA_IMPORT_ISSUES, 'p1', ['PROJ-1']);
    expect(second.data.imported).toBe(0);
    expect(second.data.skipped).toHaveLength(1);
    expect(second.data.skipped[0].key).toBe('PROJ-1');
    expect(second.data.skipped[0].specId).toMatch(/^001/);
    expect(startSpecCreation).toHaveBeenCalledTimes(1);
  });

  it('creates a second spec when allowDuplicates is true', async () => {
    configure();
    fetchMock.mockResolvedValue(jsonResponse({ issues: [rawIssue(1)] }));

    await call(IPC_CHANNELS.JIRA_IMPORT_ISSUES, 'p1', ['PROJ-1']);
    const res = await call<{ data: { imported: number; skipped: unknown[] } }>(
      IPC_CHANNELS.JIRA_IMPORT_ISSUES,
      'p1',
      ['PROJ-1'],
      true
    );
    expect(res.data.imported).toBe(1);
    expect(res.data.skipped).toHaveLength(0);
    expect(readdirSync(path.join(projectDir, '.auto-claude', 'specs'))).toHaveLength(2);
    expect(startSpecCreation).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid issue keys without calling Jira', async () => {
    configure();
    const res = await call<{ success: boolean; error?: string }>(IPC_CHANNELS.JIRA_IMPORT_ISSUES, 'p1', [
      'PROJ-1',
      'proj-1" OR 1=1',
    ]);
    expect(res.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(startSpecCreation).not.toHaveBeenCalled();
  });

  it('starts spec creation with metadata containing the Jira link', async () => {
    configure();
    fetchMock.mockResolvedValue(jsonResponse({ issues: [rawIssue(7, 'Fix login')] }));

    await call(IPC_CHANNELS.JIRA_IMPORT_ISSUES, 'p1', ['PROJ-7']);
    expect(startSpecCreation).toHaveBeenCalledTimes(1);
    const [specId, projectPath, description, specDir, metadata] = startSpecCreation.mock.calls[0];
    expect(specId).toMatch(/^001/);
    expect(projectPath).toBe(projectDir);
    expect(description).toContain('PROJ-7');
    expect(specDir).toContain(specId);
    expect(metadata).toMatchObject({
      sourceType: 'jira',
      jiraIssueKey: 'PROJ-7',
      jiraSiteUrl: SITE,
      jiraUrl: `${SITE}/browse/PROJ-7`,
    });
  });

  it('lists projects using credentials parsed from the project .env', async () => {
    configure();
    fetchMock.mockResolvedValue(jsonResponse({ values: [{ id: '1', key: 'PROJ', name: 'Project' }], isLast: true }));
    const res = await call<{ success: boolean; data: Array<{ key: string }> }>(IPC_CHANNELS.JIRA_GET_PROJECTS, 'p1');
    expect(res.data[0].key).toBe('PROJ');
  });
});
