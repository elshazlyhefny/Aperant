import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { execFileSync } from 'child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
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
// zeenha fork: let schedule races defer creation while still writing real task specs.
vi.mock('../task-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../task-store')>();
  return { ...actual, createScheduledTaskSpec: vi.fn(actual.createScheduledTaskSpec) };
});

import { runServe, EXIT_LOCKED } from '../serve';
import type { ServeOptions } from '../serve';
import type { HeadlessBridge } from '../run-task';
import { writeStopRequest } from '../stop-request';
import { createScheduledTaskSpec } from '../task-store';
import { createScheduleFileStore } from '../../schedule-file-store';
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

describe('runServe schedules', () => {
  let daemon: Promise<number> | undefined;

  afterEach(async () => {
    try {
      if (daemon) await stop(daemon);
    } finally {
      daemon = undefined;
      vi.mocked(createScheduledTaskSpec).mockReset();
    }
  });

  function serveSchedules(options: Partial<ServeOptions> = {}, limit = 2) {
    daemon = serve({ now: () => T0, tickIntervalMs: 20, ...options }, limit);
    return daemon;
  }

  function makeSchedule(over: Partial<RecurringSchedule> = {}): RecurringSchedule {
    return {
      id: 's1',
      projectId: 'desktop-project',
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
  }

  async function seedSchedules(schedules: RecurringSchedule[], filename = 'schedules.json') {
    const file = path.join(projectDir, '.auto-claude', filename);
    const store = createScheduleFileStore(file);
    for (const schedule of schedules) await store.insertSchedule(schedule);
    return { file, store };
  }

  function waitForHistory(
    store: ReturnType<typeof createScheduleFileStore>,
    id: string,
    kinds: RecurringSchedule['history'][number]['kind'][]
  ) {
    return vi.waitFor(() => {
      const schedule = store.getSchedule(id);
      if (!schedule) throw new Error(`Schedule ${id} not found`);
      expect(schedule.history.map((h) => h.kind)).toEqual(kinds);
      return schedule;
    });
  }

  it('fires a due schedule, creates a task and starts it', async () => {
    const due = makeSchedule();
    const { store } = await seedSchedules([due]);
    const p = serveSchedules();
    const schedule = await waitForHistory(store, due.id, ['started']);
    await vi.waitFor(() => expect(spawned()).toHaveLength(1));
    expect(createScheduledTaskSpec).toHaveBeenCalledWith(
      expect.objectContaining({ id: `headless:${projectDir}` }),
      due.template,
      due.id,
      T0
    );
    expect(schedule.projectId).toBe(due.projectId);
    expect(schedule.nextRunAt).toBe(T0 + DAY);
    const taskId = schedule.lastTaskId as string;
    expect(plan(taskId).status).toBe('in_progress');
    expect(spawned()[0].taskId).toBe(taskId);
    await stop(p);
    expect(plan(taskId).status).toBe('queue');
  });

  it('filters out other projects when a project ID is configured', async () => {
    const selected = makeSchedule({ projectId: 'selected-project' });
    const excluded = makeSchedule({ id: 'other', projectId: 'other-project' });
    // Put the other due row first so a daemon that ignores the filter cannot skip it by timing.
    const { file, store } = await seedSchedules([excluded, selected], 'shared-schedules.json');
    serveSchedules({ schedulesPath: file, projectId: selected.projectId });

    const schedule = await waitForHistory(store, selected.id, ['started']);
    await vi.waitFor(() => expect(spawned()).toHaveLength(1));
    expect(schedule.projectId).toBe(selected.projectId);
    expect(spawned()[0].taskId).toBe(schedule.lastTaskId);
    expect(createScheduledTaskSpec).toHaveBeenCalledTimes(1);
    expect(store.getSchedule(excluded.id)).toEqual(excluded);
  });

  it('preserves disk project identity and a concurrent acknowledgement in a shared store', async () => {
    const pendingReport = { id: 'report', kind: 'failed', at: T0 - DAY, acknowledged: false } as const;
    const due = makeSchedule({ history: [pendingReport] });
    const unrelated = makeSchedule({ id: 'other', projectId: 'other-project', nextRunAt: T0 + DAY });
    const { file, store } = await seedSchedules([due, unrelated], 'shared-schedules.json');
    const real = await vi.importActual<typeof import('../task-store')>('../task-store');
    let entered = false;
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(createScheduledTaskSpec).mockImplementationOnce(async (...args) => {
      entered = true;
      await released;
      return real.createScheduledTaskSpec(...args);
    });

    serveSchedules({ schedulesPath: file });
    let acknowledged: RecurringSchedule | undefined;
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      acknowledged = await store.updateSchedule(due.id, (current) => ({
        history: current.history.map((report) => ({ ...report, acknowledged: true })),
      }));
    } finally {
      release();
    }

    const schedule = await waitForHistory(store, due.id, ['failed', 'started']);
    expect(acknowledged?.history).toEqual([{ ...pendingReport, acknowledged: true }]);
    expect(schedule.projectId).toBe(due.projectId);
    expect(schedule.nextRunAt).toBe(T0 + DAY);
    expect(schedule.lastRunAt).toBe(T0);
    expect(schedule.lastTaskId).toEqual(expect.any(String));
    expect(schedule.history).toEqual([
      { ...pendingReport, acknowledged: true },
      expect.objectContaining({ kind: 'started', taskId: schedule.lastTaskId, acknowledged: false }),
    ]);
    expect(store.getSchedule(unrelated.id)).toEqual(unrelated);
    await vi.waitFor(() => expect(spawned().map((bridge) => bridge.taskId)).toEqual([schedule.lastTaskId]));
  });

  it('records a missed run and creates one catch-up task', async () => {
    const { store } = await seedSchedules([makeSchedule()]);
    serveSchedules({ now: () => T0 + 3 * DAY + 1000 }, 5);
    const schedule = await waitForHistory(store, 's1', ['missed', 'started']);
    await vi.waitFor(() => expect(spawned()).toHaveLength(1));
    expect(schedule.history[0].missedCount).toBe(4);
    expect(createScheduledTaskSpec).toHaveBeenCalledTimes(1);
  });

  it('stops an over-budget scheduled task; status error and a failed webhook', async () => {
    const { store } = await seedSchedules([
      makeSchedule({ template: { title: 'Nightly check', description: 'do it', tokenBudget: 100 } }),
    ]);
    const p = serveSchedules();
    const schedule = await waitForHistory(store, 's1', ['started']);
    await vi.waitFor(() => expect(spawned()).toHaveLength(1));
    const taskId = schedule.lastTaskId as string;
    writeFileSync(
      path.join(specDir(taskId), 'run_metrics.json'),
      JSON.stringify({ sessions: [{ tokens: { input: 80, output: 60 } }] })
    );
    await vi.waitFor(() => expect(webhook).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(spawned()[0].terminate).toHaveBeenCalled();
    expect(plan(taskId).status).toBe('error');
    expect(webhook.mock.calls[0][1].status).toBe('error');
    await waitForHistory(store, 's1', ['started', 'budget_exceeded']);
    await stop(p);
    expect(webhook).toHaveBeenCalledTimes(1);
  });

  it('stops an over-budget task without writing to a schedule excluded by the project filter', async () => {
    const selected = makeSchedule({ projectId: 'selected-project', enabled: false, nextRunAt: null });
    const excluded = makeSchedule({ id: 'other', projectId: 'other-project', enabled: false, nextRunAt: null });
    const { file, store } = await seedSchedules([selected, excluded], 'shared-schedules.json');
    const taskId = '001-existing';
    makeSpec(taskId, 'queue', {}, { sourceType: 'schedule', scheduleId: excluded.id, tokenBudget: 100 });
    writeFileSync(
      path.join(specDir(taskId), 'run_metrics.json'),
      JSON.stringify({ sessions: [{ tokens: { input: 80, output: 60 } }] })
    );

    serveSchedules({ schedulesPath: file, projectId: selected.projectId });

    await vi.waitFor(
      () => {
        expect(plan(taskId).status).toBe('error');
        // Budget enforcement notifies after deciding whether to persist a report.
        expect(out.join('')).toContain(`Schedules changed for ${selected.projectId}`);
      },
      { timeout: 3000 }
    );
    expect(spawned()).toHaveLength(1);
    expect(spawned()[0].taskId).toBe(taskId);
    expect(spawned()[0].terminate).toHaveBeenCalledTimes(1);
    expect(store.getSchedule(excluded.id)).toEqual(excluded);
    expect(store.getSchedule(selected.id)).toEqual(selected);
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

