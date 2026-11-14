import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const mockCreateWorktree = vi.fn();
const mockResolveAuth = vi.fn();

vi.mock('../../ai/worktree/worktree-manager', () => ({
  createOrGetWorktree: (...args: unknown[]) => mockCreateWorktree(...args),
}));
vi.mock('../auth', () => ({
  resolveHeadlessAuth: (...args: unknown[]) => mockResolveAuth(...args),
}));
vi.mock('../../ai/prompts/prompt-loader', () => ({
  tryLoadPrompt: () => 'PLANNER PROMPT',
}));

import { runHeadlessTask, runHeadlessTaskDetailed } from '../run-task';
import type { HeadlessBridge } from '../run-task';

const SECRET = 'sk-ant-super-secret-key';

class FakeBridge extends EventEmitter implements HeadlessBridge {
  spawn = vi.fn();
  terminate = vi.fn().mockResolvedValue(undefined);
}

let projectDir: string;
let out: string[];
let err: string[];
let bridge: FakeBridge;

function makeSpec(id = '001-demo'): string {
  const dir = path.join(projectDir, '.auto-claude', 'specs', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'spec.md'), '# Demo\n');
  return dir;
}

function run(overrides: Partial<Parameters<typeof runHeadlessTask>[0]> = {}) {
  return runHeadlessTask({
    projectPath: projectDir,
    spec: '001-demo',
    workerPath: '/fake/worker.js',
    createBridge: () => bridge,
    out: (t) => void out.push(t),
    err: (t) => void err.push(t),
    ...overrides,
  });
}

/** Make spawn() drive the bridge with the given events, then exit. */
function script(events: Array<Record<string, unknown>>, code = 0) {
  bridge.spawn.mockImplementation(() => {
    setImmediate(() => {
      for (const e of events) bridge.emit('task-event', '001-demo', e);
      bridge.emit('exit', '001-demo', code, 'task-execution');
    });
  });
}

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'headless-run-')));
  execFileSync('git', ['init', '-q'], { cwd: projectDir });
  out = [];
  err = [];
  bridge = new FakeBridge();
  mockCreateWorktree.mockReset();
  mockResolveAuth.mockReset();
  mockCreateWorktree.mockImplementation(async () => {
    const worktreePath = path.join(projectDir, '.auto-claude/worktrees/tasks/001-demo');
    return { worktreePath, branch: 'auto-claude/001-demo' };
  });
  mockResolveAuth.mockResolvedValue({
    auth: { apiKey: SECRET },
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-5',
  });
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('runHeadlessTask', () => {
  it('returns 0 on QA_PASSED and prints worktree and branch', async () => {
    makeSpec();
    script([{ type: 'QA_PASSED' }]);
    expect(await run()).toBe(0);
    const text = out.join('');
    expect(text).toContain('branch=auto-claude/001-demo');
    expect(text).toContain('worktree=');
    expect(mockCreateWorktree).toHaveBeenCalledOnce();
    const config = bridge.spawn.mock.calls[0][0];
    expect(config.session.agentType).toBe('build_orchestrator');
    expect(config.session.maxSteps).toBe(1000);
    expect(config.session.systemPrompt).toBe('PLANNER PROMPT');
    expect(config.session.toolContext.securityProfile.prOnlyLanding).toBe(true);
    expect(config.session.sourceSpecDir).toBe(path.join(projectDir, '.auto-claude/specs/001-demo'));
  });

  it('returns 2 on QA_MAX_ITERATIONS', async () => {
    makeSpec();
    script([{ type: 'QA_MAX_ITERATIONS' }]);
    expect(await run()).toBe(2);
  });

  it('returns 1 when planning failed', async () => {
    makeSpec();
    script([{ type: 'PLANNING_FAILED', error: 'no plan' }]);
    expect(await run()).toBe(1);
  });

  it('returns 1 when spawn throws', async () => {
    makeSpec();
    bridge.spawn.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(await run()).toBe(1);
  });

  it('returns 1 for a missing spec and creates no worktree', async () => {
    expect(await run()).toBe(1);
    expect(mockCreateWorktree).not.toHaveBeenCalled();
    expect(err.join('')).toContain('Spec not found');
  });

  it('returns 1 without credentials and creates no worktree', async () => {
    makeSpec();
    mockResolveAuth.mockRejectedValue(new Error('No credentials found.'));
    expect(await run()).toBe(1);
    expect(mockCreateWorktree).not.toHaveBeenCalled();
    expect(bridge.spawn).not.toHaveBeenCalled();
  });

  it('fails when the worktree cannot be created, with no fallback', async () => {
    makeSpec();
    mockCreateWorktree.mockRejectedValue(new Error('git exploded'));
    expect(await run()).toBe(1);
    expect(bridge.spawn).not.toHaveBeenCalled();
    expect(err.join('')).toContain("Could not create the task's git worktree");
  });

  it('fails outside a git repository', async () => {
    const plain = realpathSync(mkdtempSync(path.join(tmpdir(), 'headless-nogit-')));
    try {
      expect(await run({ projectPath: plain })).toBe(1);
      expect(mockCreateWorktree).not.toHaveBeenCalled();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('terminates the bridge on a signal and exits 1', async () => {
    makeSpec();
    bridge.spawn.mockImplementation(() => {
      setImmediate(() => process.emit('SIGTERM'));
    });
    const before = process.listenerCount('SIGTERM');
    expect(await run()).toBe(1);
    expect(bridge.terminate).toHaveBeenCalledOnce();
    expect(err.join('')).toContain('aborted by SIGTERM');
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  it('never writes the api key to out or err', async () => {
    makeSpec();
    bridge.spawn.mockImplementation(() => {
      setImmediate(() => {
        bridge.emit('log', '001-demo', `using key ${SECRET}`);
        bridge.emit('error', '001-demo', `bad key ${SECRET}`);
        bridge.emit('task-event', '001-demo', { type: 'PLANNING_FAILED', error: `key ${SECRET}` });
        bridge.emit('exit', '001-demo', 1, 'task-execution');
      });
    });
    await run({ json: true, verbose: true });
    expect(out.join('')).not.toContain(SECRET);
    expect(err.join('')).not.toContain(SECRET);
  });

  it('terminates the bridge when the abort signal fires', async () => {
    makeSpec();
    const controller = new AbortController();
    bridge.spawn.mockImplementation(() => {
      setImmediate(() => controller.abort('cancelled'));
    });
    const result = await runHeadlessTaskDetailed({
      projectPath: projectDir,
      spec: '001-demo',
      workerPath: '/fake/worker.js',
      createBridge: () => bridge,
      out: (t) => void out.push(t),
      err: (t) => void err.push(t),
      signal: controller.signal,
      handleProcessSignals: false,
    });
    expect(bridge.terminate).toHaveBeenCalledOnce();
    expect(result.aborted).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(err.join('')).toContain('aborted by cancelled');
  });

  it('handles an already-aborted signal after spawning', async () => {
    makeSpec();
    const controller = new AbortController();
    controller.abort();
    const result = await runHeadlessTaskDetailed({
      projectPath: projectDir,
      spec: '001-demo',
      workerPath: '/fake/worker.js',
      createBridge: () => bridge,
      out: (t) => void out.push(t),
      err: (t) => void err.push(t),
      signal: controller.signal,
    });
    expect(bridge.spawn).toHaveBeenCalledOnce();
    expect(bridge.terminate).toHaveBeenCalledOnce();
    expect(result.aborted).toBe(true);
  });

  it('adds no process signal listeners when handleProcessSignals is false', async () => {
    makeSpec();
    const sigint = process.listenerCount('SIGINT');
    const sigterm = process.listenerCount('SIGTERM');
    let during: number[] = [];
    bridge.spawn.mockImplementation(() => {
      during = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
      setImmediate(() => {
        bridge.emit('task-event', '001-demo', { type: 'QA_PASSED' });
        bridge.emit('exit', '001-demo', 0, 'task-execution');
      });
    });
    expect(await run({ handleProcessSignals: false })).toBe(0);
    expect(during).toEqual([sigint, sigterm]);
  });

  it('returns detailed result fields', async () => {
    makeSpec();
    script([{ type: 'QA_PASSED' }]);
    const result = await runHeadlessTaskDetailed({
      projectPath: projectDir,
      spec: '001-demo',
      workerPath: '/fake/worker.js',
      createBridge: () => bridge,
      out: (t) => void out.push(t),
      err: (t) => void err.push(t),
    });
    expect(result).toMatchObject({
      exitCode: 0,
      specId: '001-demo',
      branch: 'auto-claude/001-demo',
      aborted: false,
    });
    expect(result.worktreePath).toContain('001-demo');
    expect(result.outcome?.exitCode).toBe(0);
  });

  it('uses a supplied config instead of loading configPath', async () => {
    makeSpec();
    script([{ type: 'QA_PASSED' }]);
    expect(await run({ configPath: '/does/not/exist.json', config: { project: { mainBranch: 'dev' } } })).toBe(0);
    expect(mockCreateWorktree.mock.calls[0][2]).toBe('dev');
  });
});
