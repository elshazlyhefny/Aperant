import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { execFileSync } from 'child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
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
import { writeStopRequest } from '../stop-request';
import { createScheduledTaskSpec, listHeadlessTasks, setTaskStatus } from '../task-store';
import { createScheduleFileStore } from '../../schedule-file-store';
import { createScheduleService, type ScheduleServiceDeps } from '../../schedule-service';
import { acquireProjectQueueLock, getQueueLockPath, readLockHolder, type ProjectQueueLock } from '../../utils/project-queue-lock';
import { DEFAULT_PROJECT_SETTINGS } from '../../../shared/constants/config';
import type { Project } from '../../../shared/types';
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
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let projectDir: string;
let bridges: FakeBridge[];
let out: string[];
let err: string[];
let signalHandler: ((s: string) => void) | undefined;
let webhook: ReturnType<typeof vi.fn>;
let writeback: ReturnType<typeof vi.fn>;

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
    dispatchWriteback: writeback as never,
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
  writeback = vi.fn().mockResolvedValue(undefined);
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
    // The runner's own webhook (cli.js run) must stay off under the daemon: one notification per outcome.
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);
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
    expect(webhook.mock.calls[0][0]).toEqual({
      enabled: true,
      url: 'https://example.com/hook',
      events: { reviewReady: true, failed: true, blocked: true, prOpened: false },
    });
    await stop(p);
    expect(webhook).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('exits 1 and starts nothing when the webhook url is invalid', async () => {
    makeSpec('001-a');
    const code = await serve({ config: { webhook: { enabled: true, url: 'http://example.com/hook' } } });
    expect(code).toBe(1);
    expect(err.join('')).toContain('webhook.url is not valid');
    expect(err.join('')).not.toContain('example.com');
    expect(bridges).toHaveLength(0);
    expect(existsSync(path.join(projectDir, '.auto-claude', '.locks'))).toBe(false);
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

describe('runServe schedules', () => {
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
    try {
      await vi.waitFor(() => expect(spawned()).toHaveLength(1));
      await new Promise((r) => setTimeout(r, 100));
      expect(spawned()).toHaveLength(1);
      const schedule = readSchedule(file);
      expect(schedule.history.map((h) => h.kind)).toEqual(['missed', 'started']);
      expect(schedule.history[0].missedCount).toBe(4);
      expect(out.join('')).toContain('daily at 09:00, missed runs: catch up');
      expect(out.filter((line) => line.includes('created one catch-up task'))).toHaveLength(1);
    } finally {
      await stop(p);
    }
  });

  it('skips a missed window without creating a task and logs the next run', async () => {
    const file = writeSchedule({ missedRunPolicy: 'skip' });
    const p = serve({ now: () => T0 + 3 * DAY + 1000, tickIntervalMs: 20 }, 5);
    try {
      await vi.waitFor(() => expect(readSchedule(file).history).toMatchObject([{ kind: 'skipped_missed', missedCount: 4 }]));
      await new Promise((r) => setTimeout(r, 100));
      expect(spawned()).toHaveLength(0);
      const specsDir = path.join(projectDir, '.auto-claude', 'specs');
      expect(existsSync(specsDir) ? readdirSync(specsDir) : []).toEqual([]);
      const schedule = readSchedule(file);
      expect(schedule.nextRunAt).toBe(T0 + 4 * DAY);
      expect(schedule.history.map((h) => h.kind)).toEqual(['skipped_missed']);
      expect(out.join('')).toContain(`Schedule "nightly": daily at 09:00, missed runs: skip, next run ${new Date(T0).toISOString()}`);
      expect(out.join('')).toContain(`missed 4 runs, skipped (missed runs: skip); next run ${new Date(T0 + 4 * DAY).toISOString()}`);
    } finally {
      await stop(p);
    }
  });

  it('runs a skip schedule on time without logging previously saved history', async () => {
    const file = writeSchedule({
      missedRunPolicy: 'skip',
      history: [{ id: 'old-skip', at: T0 - DAY, kind: 'skipped_missed', missedCount: 1, acknowledged: false }],
    });
    const p = serve({ now: () => T0, tickIntervalMs: 20 });
    try {
      await vi.waitFor(() => expect(spawned()).toHaveLength(1));
      const schedule = readSchedule(file);
      expect(schedule.history.map((h) => h.kind)).toEqual(['skipped_missed', 'started']);
      expect(schedule.nextRunAt).toBe(T0 + DAY);
      const taskId = spawned()[0].taskId;
      expect(schedule.lastTaskId).toBe(taskId);
      expect(plan(taskId).status).toBe('in_progress');
      expect(out.join('')).toContain(`Schedule "nightly": created task ${taskId}`);
      expect(out.join('')).not.toContain('missed 1 run, skipped');
    } finally {
      await stop(p);
    }
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

// zeenha fork: schedule history and the next due time must survive a queue-lock handoff.
describe('schedule handoff between desktop and daemon', () => {
  const projectId = 'desktop-project';
  const schedulesPath = () => path.join(projectDir, '.auto-claude', 'schedules.json');
  const serveSchedules = (now: () => number) => serve({
    schedulesPath: schedulesPath(),
    projectId,
    now,
    tickIntervalMs: 20,
    // Queue-lock heartbeats use wall time on both sides, not the simulated schedule clock.
    lockOptions: { now: Date.now },
  });

  function desktopSide(nowRef: { now: number }) {
    const store = createScheduleFileStore(schedulesPath());
    const project: Project = {
      id: projectId,
      path: projectDir,
      name: 'desktop project',
      autoBuildPath: '.auto-claude',
      settings: { ...DEFAULT_PROJECT_SETTINGS, maxParallelTasks: 0 },
      createdAt: new Date(T0),
      updatedAt: new Date(T0),
    };
    let lock: ProjectQueueLock | undefined;
    const canRun = vi.fn(() => {
      if (lock) return true;
      const acquired = acquireProjectQueueLock(projectDir, 'desktop');
      if (!acquired.ok) return false;
      lock = acquired.lock;
      lock.startHeartbeat();
      return true;
    });
    const createTask = vi.fn<ScheduleServiceDeps['createTask']>(async (_id, template, scheduleId, scheduledFor) => {
      const task = await createScheduledTaskSpec(project, template, scheduleId, scheduledFor);
      await setTaskStatus(project, task.id, 'queue');
      return task.id;
    });
    const service = createScheduleService({
      now: () => nowRef.now,
      listSchedules: store.listSchedules,
      saveSchedule: store.saveSchedule,
      getProject: (id) => (id === projectId ? project : undefined),
      listTasks: () => listHeadlessTasks(project),
      createTask,
      startTask: vi.fn().mockResolvedValue(undefined),
      isRunning: () => false,
      stopTask: vi.fn(),
      readTaskTokens: () => 0,
      notifyChanged: vi.fn(),
      canRun,
    });
    return {
      tick: service.tick,
      canRun,
      createTask,
      release() {
        lock?.release();
        lock = undefined;
      },
    };
  }

  function scheduledTaskIds() {
    const specs = specDir('');
    if (!existsSync(specs)) return [];
    return readdirSync(specs, { withFileTypes: true })
      .filter((entry) => {
        if (!entry.isDirectory()) return false;
        const metaPath = path.join(specDir(entry.name), 'task_metadata.json');
        return existsSync(metaPath) && JSON.parse(readFileSync(metaPath, 'utf-8')).scheduleId === 's1';
      })
      .map((entry) => entry.name)
      .sort();
  }

  it.each([
    { policy: 'default', skip: false },
    { policy: 'skip', skip: true },
  ])('dispatches each run only once across a desktop → daemon → desktop handoff ($policy policy)', async ({ skip }) => {
    const file = writeSchedule({ projectId, ...(skip ? { missedRunPolicy: 'skip' } : {}) });
    const desktop = desktopSide({ now: T0 });
    try {
      await desktop.tick();
      expect(readLockHolder(projectDir)?.kind).toBe('desktop');
      expect(desktop.createTask).toHaveBeenCalledTimes(1);
      const initialTaskIds = scheduledTaskIds();
      expect(initialTaskIds).toHaveLength(1);
      const [taskId] = initialTaskIds;
      expect(readSchedule(file)).toMatchObject({
        lastTaskId: taskId,
        nextRunAt: T0 + DAY,
        history: [{ kind: 'started', taskId }],
      });
      expect(plan(taskId).status).toBe('queue');
      // Finish the original task so the unfinished-task rule does not take precedence.
      writeFileSync(
        path.join(specDir(taskId), 'implementation_plan.json'),
        JSON.stringify({ ...plan(taskId), status: 'done' })
      );
    } finally {
      desktop.release();
    }

    const daemon = serveSchedules(() => T0 + 3 * DAY + HOUR);
    const missedWindow = { missedCount: 3, missedFrom: T0 + DAY, missedTo: T0 + 3 * DAY };
    try {
      await vi.waitFor(() => {
        expect(readSchedule(file)).toMatchObject({
          projectId,
          nextRunAt: T0 + 4 * DAY,
          history: [
            { kind: 'started' },
            ...(skip ? [{ kind: 'skipped_missed', ...missedWindow }] : [{ kind: 'missed', ...missedWindow }, { kind: 'started' }]),
          ],
        });
        if (!skip) expect(spawned().map((bridge) => bridge.taskId)).toEqual([readSchedule(file).lastTaskId]);
      });
    } finally {
      await stop(daemon);
    }
    expect(readLockHolder(projectDir)).toBeNull();
    expect(spawned()).toHaveLength(skip ? 0 : 1);
    const afterDaemon = readSchedule(file);
    const afterDaemonTaskIds = scheduledTaskIds();
    expect(afterDaemonTaskIds).toHaveLength(skip ? 1 : 2);

    const restartTime = { now: T0 + 3 * DAY + 2 * HOUR };
    const restarted = desktopSide(restartTime);
    try {
      await restarted.tick();
      expect(readLockHolder(projectDir)?.kind).toBe('desktop');
      expect(restarted.createTask).not.toHaveBeenCalled();
      expect(readSchedule(file)).toEqual(afterDaemon);
      expect(scheduledTaskIds()).toEqual(afterDaemonTaskIds);

      if (skip) {
        restartTime.now = T0 + 4 * DAY + 60_000;
        await restarted.tick();
        expect(restarted.createTask).toHaveBeenCalledTimes(1);
        const next = readSchedule(file);
        expect(next.nextRunAt).toBe(T0 + 5 * DAY);
        expect(next.history.map((record) => record.kind)).toEqual(['started', 'skipped_missed', 'started']);
        expect(next.history.at(-1)).toMatchObject({ taskId: next.lastTaskId, at: restartTime.now });
      }
      expect(scheduledTaskIds()).toHaveLength(2);
    } finally {
      restarted.release();
    }
  });

  it('blocks a due desktop tick while the daemon holds the lock, then does not replay the daemon run', async () => {
    const file = writeSchedule({ projectId });
    const initial = readSchedule(file);
    const desktop = desktopSide({ now: T0 });
    // Hold the daemon just before the due time so the desktop sees a still-due schedule.
    let daemonTime = T0 - 1;
    try {
      const daemon = serveSchedules(() => daemonTime);
      try {
        await vi.waitFor(() => expect(signalHandler).toBeDefined());
        const holder = readLockHolder(projectDir);
        expect(holder?.kind).toBe('daemon');
        await desktop.tick();
        expect(desktop.canRun).toHaveReturnedWith(false);
        expect(desktop.canRun).not.toHaveReturnedWith(true);
        expect(desktop.createTask).not.toHaveBeenCalled();
        expect(readLockHolder(projectDir)?.token).toBe(holder?.token);
        expect(readSchedule(file)).toEqual(initial);
        expect(scheduledTaskIds()).toEqual([]);

        daemonTime = T0;
        await vi.waitFor(() => {
          expect(readSchedule(file)).toMatchObject({ nextRunAt: T0 + DAY, history: [{ kind: 'started' }] });
          expect(spawned().map((bridge) => bridge.taskId)).toEqual([readSchedule(file).lastTaskId]);
        });
      } finally {
        await stop(daemon);
      }
      expect(readLockHolder(projectDir)).toBeNull();
      const afterDaemon = readSchedule(file);
      await desktop.tick();
      expect(desktop.canRun).toHaveReturnedWith(true);
      expect(readLockHolder(projectDir)?.kind).toBe('desktop');
      expect(desktop.createTask).not.toHaveBeenCalled();
      expect(readSchedule(file)).toEqual(afterDaemon);
      expect(scheduledTaskIds()).toEqual([afterDaemon.lastTaskId]);
      expect(spawned()).toHaveLength(1);
    } finally {
      desktop.release();
    }
  });
});

describe('runServe stop requests', () => {
  const locksDir = () => path.join(projectDir, '.auto-claude', '.locks');
  const requestFile = (id: string) => path.join(locksDir(), `stop-request-${id}.json`);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const byTask = (id: string) => spawned().find((b) => b.taskId === id) as FakeBridge;

  it('stops only the requested task and leaves it in human_review (stopped)', async () => {
    makeSpec('001-a', 'queue', {
      phases: [{ name: 'p', subtasks: [{ id: 's1', status: 'completed' }, { id: 's2', status: 'in_progress' }] }],
    });
    makeSpec('002-b');
    const p = serve({ safetyIntervalMs: 20 });
    await vi.waitFor(() => expect(spawned()).toHaveLength(2));
    const file = writeStopRequest(projectDir, { specId: '001-a', requeue: false });
    await vi.waitFor(() => expect(plan('001-a').status).toBe('human_review'));
    expect(plan('001-a').reviewReason).toBe('stopped');
    expect(plan('001-a').phases[0].subtasks.map((s: { status: string }) => s.status)).toEqual(['completed', 'pending']);
    expect(byTask('001-a').terminate).toHaveBeenCalled();
    expect(byTask('002-b').terminate).not.toHaveBeenCalled();
    expect(plan('002-b').status).toBe('in_progress');
    expect(existsSync(file)).toBe(false);
    expect(out.join('')).toContain('001-a stopped by request');
    await sleep(150);
    expect(spawned()).toHaveLength(2);
    expect(plan('001-a').status).toBe('human_review');
    expect(webhook).not.toHaveBeenCalled();
    expect(writeback).not.toHaveBeenCalled();
    await stop(p);
  });

  it('requeue: true puts the task back in the queue and the daemon picks it up again', async () => {
    makeSpec('001-a');
    const p = serve({ safetyIntervalMs: 20 });
    await vi.waitFor(() => expect(spawned()).toHaveLength(1));
    writeStopRequest(projectDir, { specId: '001-a', requeue: true });
    await vi.waitFor(() => expect(spawned()).toHaveLength(2));
    expect(spawned().map((b) => b.taskId)).toEqual(['001-a', '001-a']);
    expect(out.join('')).toContain('001-a stopped by request, back in the queue');
    expect(webhook).not.toHaveBeenCalled();
    expect(writeback).not.toHaveBeenCalled();
    await stop(p);
  });

  it('ignores a request for a task that is not running', async () => {
    makeSpec('001-a');
    const p = serve({ safetyIntervalMs: 20 });
    await vi.waitFor(() => expect(spawned()).toHaveLength(1));
    const file = writeStopRequest(projectDir, { specId: '999-none', requeue: false });
    await vi.waitFor(() => expect(existsSync(file)).toBe(false));
    expect(out.join('')).toContain('Stop requested for 999-none, but it is not running');
    expect(spawned()[0].terminate).not.toHaveBeenCalled();
    expect(plan('001-a').status).toBe('in_progress');
    await stop(p);
  });

  it('ignores bad names, corrupt JSON and symlinks without following them', async () => {
    makeSpec('001-a');
    const p = serve({ safetyIntervalMs: 20 });
    await vi.waitFor(() => expect(spawned()).toHaveLength(1));
    const outside = path.join(projectDir, 'outside.json');
    writeFileSync(outside, JSON.stringify({ specId: '001-a', requeue: false }));
    const badName = path.join(locksDir(), 'stop-request-bad name.json');
    const corrupt = requestFile('002-x');
    const link = requestFile('001-a');
    writeFileSync(badName, JSON.stringify({ specId: '001-a', requeue: false }));
    writeFileSync(corrupt, '{not json');
    symlinkSync(outside, link);
    await vi.waitFor(() => {
      expect(existsSync(badName)).toBe(false);
      expect(existsSync(corrupt)).toBe(false);
      expect(lstatSyncOrNull(link)).toBe(false);
    });
    expect(existsSync(outside)).toBe(true);
    expect(spawned()[0].terminate).not.toHaveBeenCalled();
    expect(plan('001-a').status).toBe('in_progress');
    await stop(p);
  });

  it('discards a stale request present before startup', async () => {
    makeSpec('001-a');
    const file = writeStopRequest(projectDir, { specId: '001-a', requeue: false });
    const p = serve({ safetyIntervalMs: 20 });
    await vi.waitFor(() => expect(spawned()).toHaveLength(1));
    expect(existsSync(file)).toBe(false);
    await sleep(150);
    expect(spawned()[0].terminate).not.toHaveBeenCalled();
    expect(plan('001-a').status).toBe('in_progress');
    await stop(p);
  });
});

function lstatSyncOrNull(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

describe('runServe source write-back', () => {
  it('writes back once from settle with the event and spec dirs, and the runner does not', async () => {
    makeSpec('001-a');
    const p = serve({ config: { writeback: { github: true } } });
    await vi.waitFor(() => expect(spawned()).toHaveLength(1));
    spawned()[0].finish([{ type: 'QA_MAX_ITERATIONS' }]);
    await vi.waitFor(() => expect(writeback).toHaveBeenCalledTimes(1));
    const input = writeback.mock.calls[0][0];
    expect(input.event).toBe('blocked');
    expect(input.title).toBe('001-a');
    expect(input.specDirs).toContain(specDir('001-a'));
    expect(input.settings.issue.github).toBe(true);
    await stop(p);
    expect(writeback).toHaveBeenCalledTimes(1);
  });

  it('maps success to review_ready and an error to failed', async () => {
    makeSpec('001-a');
    makeSpec('002-b');
    const p = serve();
    await vi.waitFor(() => expect(spawned()).toHaveLength(2));
    const byTask = (id: string) => spawned().find((b) => b.taskId === id) as FakeBridge;
    byTask('001-a').finish([{ type: 'QA_PASSED' }]);
    byTask('002-b').finish([{ type: 'CODING_FAILED', error: 'x' }]);
    await vi.waitFor(() => expect(writeback).toHaveBeenCalledTimes(2));
    const events = writeback.mock.calls.map((c) => [c[0].title, c[0].event]);
    expect(events).toContainEqual(['001-a', 'review_ready']);
    expect(events).toContainEqual(['002-b', 'failed']);
    await stop(p);
  });

  it('reports an account pause to the webhook as account_required and does not write it back', async () => {
    makeSpec('001-a');
    const p = serve();
    await vi.waitFor(() => expect(spawned()).toHaveLength(1));
    spawned()[0].finish([{ type: 'PHASE_ACCOUNT_UNAVAILABLE', error: 'no account for openai' }], 3);
    await vi.waitFor(() => expect(webhook).toHaveBeenCalledTimes(1));
    expect(plan('001-a').status).toBe('human_review');
    expect(plan('001-a').reviewReason).toBe('account_required');
    expect(webhook.mock.calls[0][1]).toMatchObject({ status: 'human_review', reviewReason: 'account_required' });
    await stop(p);
    expect(writeback).not.toHaveBeenCalled();
  });

  it('does not write back for an interrupted run', async () => {
    makeSpec('001-a');
    const p = serve();
    await vi.waitFor(() => expect(spawned()).toHaveLength(1));
    signalHandler?.('SIGTERM');
    await p;
    expect(writeback).not.toHaveBeenCalled();
  });

  it('still sends the webhook when write-back throws', async () => {
    makeSpec('001-a');
    writeback.mockRejectedValue(new Error('boom'));
    const p = serve();
    await vi.waitFor(() => expect(spawned()).toHaveLength(1));
    spawned()[0].finish([{ type: 'QA_PASSED' }]);
    await vi.waitFor(() => expect(writeback).toHaveBeenCalledTimes(1));
    expect(webhook).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(out.join('')).toContain('Write-back for 001-a failed'));
    await stop(p);
  });
});

