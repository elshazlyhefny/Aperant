/**
 * Tests for the TASK_RUN_METRICS_GET IPC handler.
 * Uses a real temp directory for run_metrics.json.
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
  projectStore: { getProject: vi.fn() }
}));

vi.mock('../../../task-log-service', () => ({
  taskLogService: {
    loadLogs: vi.fn(),
    startWatching: vi.fn(),
    stopWatching: vi.fn(),
    on: vi.fn()
  }
}));

vi.mock('../../../utils/spec-path-helpers', () => ({
  isValidTaskId: vi.fn((id: string) => {
    if (!id || typeof id !== 'string') return false;
    if (id.includes('/') || id.includes('\\')) return false;
    if (id === '.' || id === '..') return false;
    if (id.includes('\0')) return false;
    return true;
  })
}));

vi.mock('../../../../shared/utils/debug-logger', () => ({
  debugLog: vi.fn(),
  debugWarn: vi.fn()
}));

vi.mock('../../../utils/path-helpers', () => ({
  ensureAbsolutePath: vi.fn((p: string) => {
    const pathMod = require('path');
    return pathMod.isAbsolute(p) ? p : pathMod.resolve(p);
  })
}));

describe('TASK_RUN_METRICS_GET handler', () => {
  let handler: Function;
  let tmpRoot: string;

  const entry = (overrides: Record<string, unknown> = {}) => ({
    sessionId: 's1',
    agentType: 'coder',
    phase: 'coding',
    outcome: 'completed',
    startedAt: '2024-01-01T00:00:00Z',
    durationMs: 1000,
    steps: 2,
    toolCalls: 3,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    tools: {},
    slowest: [],
    ...overrides
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'run-metrics-handler-'));
    const handlers: Record<string, Function> = {};
    (ipcMain.handle as Mock).mockImplementation((channel: string, h: Function) => {
      handlers[channel] = h;
    });
    const { registerTaskLogsHandlers } = await import('../logs-handlers');
    registerTaskLogsHandlers(() => null);
    handler = handlers[IPC_CHANNELS.TASK_RUN_METRICS_GET];
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    vi.resetModules();
  });

  async function mockProject() {
    const { projectStore } = await import('../../../project-store');
    (projectStore.getProject as Mock).mockReturnValue({
      id: 'p1',
      path: tmpRoot,
      autoBuildPath: '.auto-claude'
    });
  }

  it('registers the handler', () => {
    expect(handler).toBeTypeOf('function');
  });

  it('rejects an invalid spec id', async () => {
    const result = await handler({}, 'p1', '../evil');
    expect(result.success).toBe(false);
  });

  it('fails for an unknown project', async () => {
    const { projectStore } = await import('../../../project-store');
    (projectStore.getProject as Mock).mockReturnValue(undefined);
    const result = await handler({}, 'nope', '001-test');
    expect(result.success).toBe(false);
  });

  it('returns null data when the spec dir or file is missing', async () => {
    await mockProject();
    const result = await handler({}, 'p1', '001-test');
    expect(result).toEqual({ success: true, data: null });
  });

  it('returns sessions and summary when the file exists', async () => {
    await mockProject();
    const specDir = path.join(tmpRoot, '.auto-claude', 'specs', '001-test');
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(
      path.join(specDir, 'run_metrics.json'),
      JSON.stringify({ sessions: [entry()] })
    );
    const result = await handler({}, 'p1', '001-test');
    expect(result.success).toBe(true);
    expect(result.data.sessions).toHaveLength(1);
    expect(result.data.summary).toBeDefined();
  });
});
