/**
 * Tests for the PROJECT_RUN_METRICS_GET IPC handler.
 * Uses a real temp directory for run_metrics.json files.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { ipcMain } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { IPC_CHANNELS } from '../../../../shared/constants';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: vi.fn()
}));

vi.mock('../../../project-store', () => ({
  projectStore: { getProject: vi.fn(), getTasks: vi.fn() }
}));

vi.mock('../../../utils/path-helpers', () => ({
  ensureAbsolutePath: vi.fn((p: string) => {
    const pathMod = require('path');
    return pathMod.isAbsolute(p) ? p : pathMod.resolve(p);
  })
}));

describe('PROJECT_RUN_METRICS_GET handler', () => {
  let handler: Function;
  let tmpRoot: string;
  let specsDir: string;

  const entry = (overrides: Record<string, unknown> = {}) => ({
    sessionId: 's1',
    agentType: 'coder',
    phase: 'coding',
    outcome: 'completed',
    startedAt: new Date().toISOString(),
    durationMs: 1000,
    steps: 2,
    toolCalls: 3,
    model: 'claude-x',
    tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 },
    tools: {},
    slowest: [],
    ...overrides
  });

  const task = (specId: string, status: string, extra: Record<string, unknown> = {}) => ({
    specId,
    status,
    title: specId,
    updatedAt: new Date(),
    ...extra
  });

  const writeMetrics = (specId: string, content: string) => {
    const dir = path.join(specsDir, specId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run_metrics.json'), content);
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-run-metrics-handler-'));
    specsDir = path.join(tmpRoot, '.auto-claude', 'specs');
    const handlers: Record<string, Function> = {};
    (ipcMain.handle as Mock).mockImplementation((channel: string, h: Function) => {
      handlers[channel] = h;
    });
    const { registerProjectRunMetricsHandlers } = await import('../project-run-metrics-handlers');
    registerProjectRunMetricsHandlers();
    handler = handlers[IPC_CHANNELS.PROJECT_RUN_METRICS_GET];
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function mockProject(tasks: unknown[]) {
    const { projectStore } = await import('../../../project-store');
    (projectStore.getProject as Mock).mockReturnValue({
      id: 'p1',
      path: tmpRoot,
      autoBuildPath: '.auto-claude'
    });
    (projectStore.getTasks as Mock).mockReturnValue(tasks);
  }

  it('registers the handler', () => {
    expect(handler).toBeTypeOf('function');
  });

  it('aggregates completed, error, in-progress and corrupt tasks', async () => {
    writeMetrics('001-done', JSON.stringify({ sessions: [entry()] }));
    writeMetrics('002-err', JSON.stringify({ sessions: [entry({ outcome: 'error' })] }));
    writeMetrics('003-wip', JSON.stringify({ sessions: [entry()] }));
    writeMetrics('004-bad', '{not json');
    writeMetrics('005-archived', JSON.stringify({ sessions: [entry()] }));
    await mockProject([
      task('001-done', 'done'),
      task('002-err', 'human_review'),
      task('003-wip', 'in_progress'),
      task('004-bad', 'done'),
      task('005-archived', 'done', { metadata: { archivedAt: '2024-01-01' } })
    ]);

    const result = await handler({}, 'p1', { periodDays: null });
    expect(result.success).toBe(true);
    expect(result.data.taskCount).toBe(4);
    expect(result.data.excluded.corrupt).toBe(1);
    expect(result.data.completedTasks).toBe(1);
    expect(result.data.totals.sessions).toBe(3);
  });

  it('rejects an invalid period', async () => {
    await mockProject([]);
    for (const periodDays of [0, -1, 1.5, 4000, Number.NaN, Infinity, '7']) {
      const result = await handler({}, 'p1', { periodDays });
      expect(result.success).toBe(false);
    }
  });

  it('rejects a non-string project id', async () => {
    const result = await handler({}, 42, { periodDays: 7 });
    expect(result.success).toBe(false);
  });

  it('fails for an unknown project', async () => {
    const { projectStore } = await import('../../../project-store');
    (projectStore.getProject as Mock).mockReturnValue(undefined);
    const result = await handler({}, 'nope', { periodDays: 7 });
    expect(result).toEqual({ success: false, error: 'Project not found' });
  });

  it('returns zeroed data for a project with no tasks', async () => {
    await mockProject([]);
    const result = await handler({}, 'p1', { periodDays: 30 });
    expect(result.success).toBe(true);
    expect(result.data.taskCount).toBe(0);
    expect(result.data.totals.sessions).toBe(0);
    expect(result.data.totals.totalTokens).toBe(0);
  });
});
