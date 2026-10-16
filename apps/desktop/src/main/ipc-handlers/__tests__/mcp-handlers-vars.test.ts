/**
 * zeenha fork: "Test connection" must check a custom server the way an agent
 * sees it, with `${NAME}` references expanded from the project's .env.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, app: { getPath: () => tmpdir() } }));
// Keep test noise out of the real ~/.config/aperant/logs/main.log.
vi.mock('../../app-logger', () => ({ appLog: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

const projects: Array<{ id: string; path: string; autoBuildPath: string }> = [];
vi.mock('../../project-store', () => ({ projectStore: { getProjects: () => projects } }));

import { resolveForCheck } from '../mcp-handlers';
import type { CustomMcpServer } from '../../../shared/types/project';

const ref = (name: string): string => `$${'{'}${name}}`;

const github: CustomMcpServer = {
  id: 'github',
  name: 'GitHub',
  type: 'http',
  url: 'https://api.githubcopilot.com/mcp/',
  headers: { Authorization: `Bearer ${ref('GITHUB_TOKEN')}` },
};

describe('resolveForCheck', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mcp-check-'));
    mkdirSync(path.join(dir, '.auto-claude'));
    projects.length = 0;
    projects.push({ id: 'p1', path: dir, autoBuildPath: '.auto-claude' });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns a server without references unchanged', () => {
    const plain: CustomMcpServer = { id: 'x', name: 'x', type: 'command', command: 'npx', args: ['-y', 'y'] };
    expect(resolveForCheck(plain)).toBe(plain);
  });

  it('expands references from the project the page is showing', () => {
    writeFileSync(path.join(dir, '.auto-claude', '.env'),
      `GITHUB_TOKEN=gho_test\nCUSTOM_MCP_SERVERS=${JSON.stringify([github])}\n`);
    expect(resolveForCheck(github, 'p1')?.headers).toEqual({ Authorization: 'Bearer gho_test' });
  });

  it('refuses (null) when the variable is missing, instead of sending the placeholder', () => {
    writeFileSync(path.join(dir, '.auto-claude', '.env'), `CUSTOM_MCP_SERVERS=${JSON.stringify([github])}\n`);
    expect(resolveForCheck(github, 'p1')).toBeNull();
  });

  it('refuses (null) without a project to read variables from', () => {
    expect(resolveForCheck(github)).toBeNull();
    expect(resolveForCheck(github, 'unknown')).toBeNull();
  });
});
