/**
 * zeenha fork: approval IPC, auto-approve of servers the user adds on the page,
 * and the git-tracked .env check.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let userData = '';
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, app: { getPath: () => userData } }));
vi.mock('../../app-logger', () => ({ appLog: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock('../../cli-tool-manager', () => ({ getToolPath: () => 'git' }));

const projects: Array<{ id: string; path: string; autoBuildPath: string }> = [];
vi.mock('../../project-store', () => ({
  projectStore: {
    getProjects: () => projects,
    getProject: (id: string) => projects.find((p) => p.id === id),
  },
}));

import { ipcMain } from 'electron';
import { approveChromeIfUnchanged, approveServerIfUnchanged } from '../mcp-handlers';
import { registerEnvHandlers } from '../env-handlers';
import { getApprovals } from '../../mcp-approval-store';
import { describeProjectMcpTrust } from '../../ai/mcp/project-settings';
import { isAutoBuildEnvTrackedByGit } from '../../project-initializer';
import { IPC_CHANNELS } from '../../../shared/constants';

const server = (id: string, script: string) => ({ id, name: id, type: 'command', command: 'node', args: [script] });

describe('mcp approval handlers', () => {
  let dir: string;
  const envFile = () => path.join(dir, '.auto-claude', '.env');
  const writeServers = (list: unknown[]) =>
    writeFileSync(envFile(), `CUSTOM_MCP_SERVERS=${JSON.stringify(list)}\n`);

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mcp-appr-'));
    userData = mkdtempSync(path.join(tmpdir(), 'mcp-appr-ud-'));
    mkdirSync(path.join(dir, '.auto-claude'));
    projects.length = 0;
    projects.push({ id: 'p1', path: dir, autoBuildPath: '.auto-claude' });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  });

  const hashOf = (id: string) =>
    describeProjectMcpTrust(dir, '.auto-claude', undefined).servers.find((t) => t.server.id === id)!.hash;

  it('approves a server whose hash matches what was shown', () => {
    writeServers([server('a', 'tools/a.js')]);
    const hash = hashOf('a');
    expect(approveServerIfUnchanged('p1', 'a', hash)).toEqual({ success: true });
    expect(getApprovals(dir).servers).toEqual([hash]);
  });

  it('refuses when the definition changed since it was shown', () => {
    writeServers([server('a', 'tools/a.js')]);
    const shown = hashOf('a');
    writeServers([server('a', 'tools/evil.js')]);
    const result = approveServerIfUnchanged('p1', 'a', shown);
    expect(result.success).toBe(false);
    expect(result.error).toContain('changed since it was shown');
    expect(getApprovals(dir).servers).toEqual([]);
  });

  it('approves the Chrome executable only when the path is unchanged', () => {
    writeFileSync(envFile(), 'CHROME_DEVTOOLS_EXECUTABLE=/opt/chrome/chrome\n');
    expect(approveChromeIfUnchanged('p1', '/tmp/other').success).toBe(false);
    expect(approveChromeIfUnchanged('p1', '/opt/chrome/chrome').success).toBe(true);
    expect(getApprovals(dir).chromeExecutables).toEqual(['/opt/chrome/chrome']);
  });

  it('ENV_UPDATE approves a newly added server but not a pre-existing one', async () => {
    writeServers([server('old', 'tools/old.js')]);
    registerEnvHandlers(() => null);
    const call = (ipcMain.handle as unknown as { mock: { calls: Array<[string, (...a: unknown[]) => Promise<unknown>]> } })
      .mock.calls.find((c) => c[0] === IPC_CHANNELS.ENV_UPDATE)![1];
    const result = await call({}, 'p1', { customMcpServers: [server('old', 'tools/old.js'), server('new', 'tools/new.js')] });
    expect(result).toEqual({ success: true });
    const approved = getApprovals(dir).servers;
    expect(approved).toContain(hashOf('new'));
    expect(approved).not.toContain(hashOf('old'));
  });
});

describe('isAutoBuildEnvTrackedByGit', () => {
  let dir: string;
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, stdio: 'ignore' });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mcp-git-'));
    mkdirSync(path.join(dir, '.auto-claude'));
    writeFileSync(path.join(dir, '.auto-claude', '.env'), 'A=1\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is false outside a git repository', () => {
    expect(isAutoBuildEnvTrackedByGit(dir)).toBe(false);
  });

  it('is false when the file is untracked, true once committed', () => {
    git('init');
    expect(isAutoBuildEnvTrackedByGit(dir)).toBe(false);
    git('add', '-f', '.auto-claude/.env');
    git('commit', '-m', 'x');
    expect(isAutoBuildEnvTrackedByGit(dir)).toBe(true);
  });
});
