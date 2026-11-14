import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

vi.mock('../../ai/worktree/worktree-manager', () => ({
  createOrGetWorktree: async (projectPath: string, specId: string) => ({
    worktreePath: path.join(projectPath, '.auto-claude/worktrees/tasks', specId),
    branch: `auto-claude/${specId}`,
  }),
}));
vi.mock('../auth', () => ({
  resolveHeadlessAuth: async () => ({ auth: { apiKey: 'sk-test' }, provider: 'anthropic', modelId: 'claude-sonnet-4-5' }),
}));
vi.mock('../../ai/prompts/prompt-loader', () => ({ tryLoadPrompt: () => 'PLANNER PROMPT' }));

import { runServe, EXIT_LOCKED } from '../serve';
import type { ServeOptions } from '../serve';
import type { HeadlessBridge } from '../run-task';
import { acquireProjectQueueLock, getQueueLockPath } from '../../utils/project-queue-lock';
import type { RecurringSchedule } from '../../../shared/types/schedule';

class FakeBridge extends EventEmitter implements HeadlessBridge {
  taskId = '';
  spawn = vi.fn((config: { taskId: string }) => {
    this.taskId = config.taskId;
  });
  terminate = vi.fn(async () => {
    setImmediate(() => this.emit('exit', this.taskId, 143, 'task-execution'));
  });
  finish(events: Array<Record<string, unknown>>, code = 0) {
    for (const e of events) this.emit('task-event', this.taskId, e);
    this.emit('exit', this.taskId, code, 'task-execution');
  }
}

const T0 = new Date(2026, 5, 10, 9, 0, 0).getTime();
const DAY = 24 * 3_600_000;

let projectDir: string;
let bridges: FakeBridge[];
let out: string[];
let err: string[];
let signalHandler: ((s: string) => void) | undefined;
let webhook: ReturnType<typeof vi.fn>;

function specDir(id: string) {
  return path.join(projectDir, '.auto-claude', 'specs', id);
}

function makeSpec(id: string, status = 'queue', extra: Record<string, unknown> = {}, metadata?: Record<string, unknown>) {
  const dir = specDir(id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'spec.md'), `# ${id}\n`);
  writeFileSync(
    path.join(dir, 'implementation_plan.json'),
    JSON.stringify({ feature: id, status, created_at: new Date(Date.now() + bridges.length).toISOString(), phases: [], ...extra })
  );
  if (metadata) writeFileSync(path.join(dir, 'task_metadata.json'), JSON.stringify(metadata));
}

function plan(id: string): Record<string, any> {
  return JSON.parse(readFileSync(path.join(specDir(id), 'implementation_plan.json'), 'utf-8'));
}

function serve(overrides: Partial<ServeOptions> = {}, limit = 2) {
  return runServe({
    projectPath: projectDir,
    workerPath: '/fake/worker.js',
    config: { project: { maxParallelTasks: limit }, webhook: { enabled: true, url: 'https://example.com/hook', events: { reviewReady: true, failed: true, blocked: true, prOpened: false } } },
    createBridge: () => {
      const b = new FakeBridge();
      bridges.push(b);
      return b;
    },
    out: (t) => void out.push(t),
    err: (t) => void err.push(t),
    installSignalHandlers: (on) => {
      signalHandler = on;
      return () => {
        signalHandler = undefined;
      };
    },
    dispatchWebhook: webhook as never,
    shutdownTimeoutMs: 2000,
    ...overrides,
  });
}

const spawned = () => bridges.filter((b) => b.spawn.mock.calls.length > 0);

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'headless-serve-')));
  execFileSync('git', ['init', '-q'], { cwd: projectDir });
  bridges = [];
  out = [];
  err = [];
  signalHandler = undefined;
  webhook = vi.fn();
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

async function stop(p: Promise<number>): Promise<number> {
  signalHandler?.('SIGTERM');
  return p;
}

describe('runServe queue', () => {
  it('respects maxParallelTasks and starts the next task when a slot frees', async () => {
    makeSpec('001-a');
    makeSpec('002-b');
    makeSpec('003-c');
    const p = serve();
    await vi.waitFor(() => expect(spawned()).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 50));
    expect(spawned()).toHaveLength(2);
    expect(plan('001-a').status).toBe('in_progress');
    expect(plan('003-c').status).toBe('queue');

    spawned()[0].finish([{ type: 'QA_PASSED' }]);
    await vi.waitFor(() => expect(spawned()).toHaveLength(3));
    expect(plan('001-a').status).toBe('human_review');
    expect(plan('001-a').reviewReason).toBe('completed');
    expect(await stop(p)).toBe(0);
  });

  it('starts a dependent only after its dependency is done', async () => {
    makeSpec('001-base');
    makeSpec('002-dep', 'queue', {}, { taskDependencies: ['001-base'] });
    makeSpec('003-other');
    const p = serve({}, 3);
    await vi.waitFor(() => expect(spawned()).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 50));
    expect(spawned().map((b) => b.taskId).sort()).toEqual(['001-base', '003-other']);
    expect(plan('002-dep').status).toBe('queue');

    // The dependency becomes done (merged elsewhere); the next queue pass starts the dependent
    writeFileSync(
      path.join(specDir('001-base'), 'implementation_plan.json'),
      JSON.stringify({ feature: 'base', status: 'done', phases: [] })
    );
    spawned().find((b) => b.taskId === '003-other')?.finish([{ type: 'QA_PASSED' }]);
    await vi.waitFor(() => expect(spawned().map((b) => b.taskId)).toContain('002-dep'));
    await stop(p);
  });

  it('maps outcomes to statuses and sends one webhook per terminal outcome', async () => {
    makeSpec('001-a');
    makeSpec('002-b');
    const p = serve();
    await vi.waitFor(() => expect(spawned()).toHaveLength(2));
    const byTask = (id: string) => spawned().find((b) => b.taskId === id) as FakeBridge;
    byTask('001-a').finish([{ type: 'QA_MAX_ITERATIONS' }]);
    byTask('002-b').finish([{ type: 'CODING_FAILED', error: 'x' }]);
    await vi.waitFor(() => expect(webhook).toHaveBeenCalledTimes(2));
    expect(plan('001-a').status).toBe('human_review');
    expect(plan('001-a').reviewReason).toBe('qa_rejected');
    expect(plan('002-b').status).toBe('error');
    const statuses = webhook.mock.calls.map((c) => [c[1].status, c[1].reviewReason]);
    expect(statuses).toContainEqual(['human_review', 'qa_rejected']);
    expect(statuses).toContainEqual(['error', undefined]);
    await stop(p);
    expect(webhook).toHaveBeenCalledTimes(2);
  });

  it('exits 3 and starts nothing when a desktop holds the lock', async () => {
    makeSpec('001-a');
    const held = acquireProjectQueueLock(projectDir, 'desktop');
    expect(held.ok).toBe(true);
    const code = await serve();
    expect(code).toBe(EXIT_LOCKED);
    expect(err.join('')).toContain('Cannot start: project queue is already run by desktop app');
    expect(err.join('')).toContain(`pid ${process.pid}`);
    expect(bridges).toHaveLength(0);
    expect(plan('001-a').status).toBe('queue');
    if (held.ok) held.lock.release();
  });

  it('SIGTERM terminates bridges, requeues tasks, resets stuck subtasks and removes the lock', async () => {
    makeSpec('001-a', 'queue', {
      phases: [{ name: 'p', subtasks: [{ id: 's1', status: 'completed' }, { id: 's2', status: 'in_progress' }] }],
    });
    const p = serve();
    await vi.waitFor(() => expect(spawned()).toHaveLength(1));
    expect(existsSync(getQueueLockPath(projectDir))).toBe(true);
    signalHandler?.('SIGTERM');
    expect(await p).toBe(0);
    expect(spawned()[0].terminate).toHaveBeenCalled();
    const after = plan('001-a');
    expect(after.status).toBe('queue');
    expect(after.phases[0].subtasks.map((s: { status: string }) => s.status)).toEqual(['completed', 'pending']);
    expect(existsSync(getQueueLockPath(projectDir))).toBe(false);
    expect(webhook).not.toHaveBeenCalled();
  });

  it('recovers tasks left running by a crashed daemon', async () => {
    makeSpec('001-a', 'in_progress', {
      phases: [{ name: 'p', subtasks: [{ id: 's1', status: 'in_progress' }] }],
    });
    mkdirSync(path.join(projectDir, '.auto-claude', '.locks'), { recursive: true });
    writeFileSync(path.join(projectDir, '.auto-claude', '.locks', 'serve-running.json'), JSON.stringify({ taskIds: ['001-a'] }));
    const p = serve({}, 0);
    await vi.waitFor(() => expect(plan('001-a').status).toBe('queue'));
    expect(plan('001-a').phases[0].subtasks[0].status).toBe('pending');
    await stop(p);
  });
});

describe('runServe schedules', () => {
  function writeSchedule(over: Partial<RecurringSchedule> = {}) {
    const file = path.join(projectDir, '.auto-claude', 'schedules.json');
    const schedule: RecurringSchedule = {
      id: 's1',
      projectId: 'whatever',
      name: 'nightly',
      enabled: true,
      cadence: { kind: 'daily', time: '09:00' },
      template: { title: 'Nightly check', description: 'do it', tokenBudget: 1000 },
      createdAt: 0,
      updatedAt: 0,
      nextRunAt: T0,
      history: [],
      ...over,
    };
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, schedules: [schedule] }));
    return file;
  }
  const readSchedule = (file: string): RecurringSchedule => JSON.parse(readFileSync(file, 'utf-8')).schedules[0];

  it('fires a due schedule, creates a task and starts it', async () => {
    const file = writeSchedule();
    const p = serve({ now: () => T0, tickIntervalMs: 20 });
    await vi.waitFor(() => expect(spawned()).toHaveLength(1));
    const schedule = readSchedule(file);
    expect(schedule.projectId).toBe('whatever');
    expect(schedule.history.map((h) => h.kind)).toEqual(['started']);
    expect(schedule.nextRunAt).toBe(T0 + DAY);
    const taskId = schedule.lastTaskId as string;
    expect(plan(taskId).status).toBe('in_progress');
    expect(spawned()[0].taskId).toBe(taskId);
    await stop(p);
    expect(plan(taskId).status).toBe('queue');
  });

  it('records a missed run and creates one catch-up task', async () => {
    const file = writeSchedule();
    const p = serve({ now: () => T0 + 3 * DAY + 1000, tickIntervalMs: 20 }, 5);
    await vi.waitFor(() => expect(spawned()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(spawned()).toHaveLength(1);
    const schedule = readSchedule(file);
    expect(schedule.history.map((h) => h.kind)).toEqual(['missed', 'started']);
    expect(schedule.history[0].missedCount).toBe(4);
    await stop(p);
  });

  it('stops an over-budget scheduled task; status error and a failed webhook', async () => {
    const file = writeSchedule({ template: { title: 'Nightly check', description: 'do it', tokenBudget: 100 } });
    const p = serve({ now: () => T0, tickIntervalMs: 20 });
    await vi.waitFor(() => expect(spawned()).toHaveLength(1));
    const taskId = readSchedule(file).lastTaskId as string;
    writeFileSync(
      path.join(specDir(taskId), 'run_metrics.json'),
      JSON.stringify({ sessions: [{ tokens: { input: 80, output: 60 } }] })
    );
    await vi.waitFor(() => expect(webhook).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(spawned()[0].terminate).toHaveBeenCalled();
    expect(plan(taskId).status).toBe('error');
    expect(webhook.mock.calls[0][1].status).toBe('error');
    expect(readSchedule(file).history.map((h) => h.kind)).toContain('budget_exceeded');
    await stop(p);
    expect(webhook).toHaveBeenCalledTimes(1);
  });
});
