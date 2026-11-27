/**
 * zeenha fork: recurring schedule service, driven by fake dependencies.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Project, Task } from '../../shared/types';
import type { MissedRunPolicy, RecurringSchedule, ScheduleRunRecord } from '../../shared/types/schedule';
import {
  createScheduleService,
  describeMissedRunPolicy,
  describeScheduleRecord,
  type ScheduleServiceDeps,
} from '../schedule-service';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = new Date(2026, 5, 10, 9, 0, 0).getTime();

function makeSchedule(over: Partial<RecurringSchedule> = {}): RecurringSchedule {
  return {
    id: 's1',
    projectId: 'p1',
    name: 'deps',
    enabled: true,
    cadence: { kind: 'daily', time: '09:00' },
    template: { title: 'Update deps', description: 'do it', tokenBudget: 1000 },
    createdAt: 0,
    updatedAt: 0,
    nextRunAt: T0,
    history: [],
    ...over,
  };
}

function setup(opts: { schedules?: RecurringSchedule[]; maxParallel?: number; noProject?: boolean; now?: number } = {}) {
  const schedules = opts.schedules ?? [makeSchedule()];
  const tasks: Task[] = [];
  const project = { id: 'p1', path: '/repo', settings: { maxParallelTasks: opts.maxParallel } } as unknown as Project;
  let now = opts.now ?? T0;
  let counter = 0;
  const running = new Set<string>();
  const tokens = { value: 0 };
  const deps: ScheduleServiceDeps = {
    now: () => now,
    listSchedules: () => schedules.map((s) => ({ ...s })),
    updateSchedule: vi.fn<ScheduleServiceDeps['updateSchedule']>(async (id, mutate) => {
      const index = schedules.findIndex((schedule) => schedule.id === id);
      if (index < 0) return false;
      const current = schedules[index];
      schedules[index] = { ...current, ...mutate(structuredClone(current)) };
      return true;
    }),
    getProject: (id) => (id === 'p1' && !opts.noProject ? project : undefined),
    listTasks: () => tasks,
    createTask: vi.fn(async (_p, _t, scheduleId) => {
      const id = `t${++counter}`;
      tasks.push({
        id,
        specId: id,
        status: 'queue',
        createdAt: new Date(counter),
        metadata: { sourceType: 'schedule', scheduleId },
      } as unknown as Task);
      return id;
    }),
    startTask: vi.fn(async (id: string) => {
      const t = tasks.find((x) => x.id === id) as Task;
      t.status = 'in_progress';
    }),
    isRunning: (id) => running.has(id),
    notifyChanged: vi.fn(),
    readTaskTokens: vi.fn(() => tokens.value),
    stopTask: vi.fn(),
  };
  return {
    tokens,
    deps,
    schedules,
    tasks,
    service: createScheduleService(deps),
    setNow: (n: number) => {
      now = n;
    },
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function deferTaskCreation(deps: ScheduleServiceDeps) {
  const entered = deferred();
  const release = deferred();
  const createTask = deps.createTask;
  deps.createTask = vi.fn<ScheduleServiceDeps['createTask']>(async (...args) => {
    entered.resolve();
    await release.promise;
    return createTask(...args);
  });
  return { entered: entered.promise, release: release.resolve, fail: release.reject };
}

describe('in-flight schedule writeback', () => {
  it('merges a timed success after pause without losing an acknowledgement or a new report', async () => {
    const originalReport = { id: 'report1', kind: 'missed', at: T0 - DAY, acknowledged: false } as const;
    const newReport = { id: 'report2', kind: 'budget_exceeded', at: T0, acknowledged: false } as const;
    const { deps, schedules, service, setNow } = setup({ schedules: [makeSchedule({ history: [originalReport] })] });
    const creation = deferTaskCreation(deps);
    const tick = service.tick();
    await creation.entered;
    const paused = {
      ...schedules[0],
      name: 'Edited',
      template: { ...schedules[0].template, title: 'New template' },
      enabled: false,
      nextRunAt: null,
      updatedAt: T0 + 1,
      history: [{ ...originalReport, acknowledged: true }, newReport],
    };
    schedules[0] = paused;
    setNow(T0 + 1);
    creation.release();
    await tick;

    expect(schedules[0]).toEqual({
      ...paused,
      lastRunAt: T0,
      lastTaskId: 't1',
      history: [...paused.history, expect.objectContaining({ kind: 'started', taskId: 't1', at: T0 })],
    });
    expect(deps.notifyChanged).toHaveBeenCalledExactlyOnceWith('p1');
  });

  const timedEdits: [string, Partial<RecurringSchedule>][] = [
    ['cadence', { cadence: { kind: 'daily', time: '10:00' } }],
    ['due time', { nextRunAt: T0 + HOUR }],
  ];
  it.each(timedEdits)('keeps a changed %s when timed creation fails', async (_field, edit) => {
    const { deps, schedules, service } = setup({
      schedules: [makeSchedule({ lastRunAt: T0 - DAY, lastTaskId: 'previous' })],
    });
    const creation = deferTaskCreation(deps);
    const tick = service.tick();
    await creation.entered;
    const edited = { ...schedules[0], ...edit };
    schedules[0] = edited;
    creation.fail(new Error('disk full'));
    await tick;

    expect(schedules[0]).toEqual({
      ...edited,
      history: [expect.objectContaining({ kind: 'failed', detail: 'disk full' })],
    });
  });

  it('advances a weekly cadence with the same time and days in a different order', async () => {
    const { deps, schedules, service } = setup({
      schedules: [makeSchedule({ cadence: { kind: 'weekly', days: [3, 4], time: '09:00' } })],
    });
    const creation = deferTaskCreation(deps);
    const tick = service.tick();
    await creation.entered;
    const cadence: RecurringSchedule['cadence'] = { time: '09:00', days: [4, 3], kind: 'weekly' };
    schedules[0] = { ...schedules[0], cadence };
    creation.release();
    await tick;

    expect(schedules[0].cadence).toEqual(cadence);
    expect(schedules[0].nextRunAt).toBe(T0 + DAY);
  });

  it.each([T0 + 2 * DAY, null])('preserves a manual run’s new nextRunAt (%s)', async (nextRunAt) => {
    const { deps, schedules, service } = setup({ schedules: [makeSchedule({ nextRunAt: T0 + DAY })] });
    const creation = deferTaskCreation(deps);
    const run = service.runNow('s1');
    await creation.entered;
    const edited = { ...schedules[0], nextRunAt, enabled: nextRunAt !== null };
    schedules[0] = edited;
    creation.release();

    await expect(run).resolves.toEqual({ started: true, taskId: 't1' });
    expect(schedules[0]).toEqual({
      ...edited,
      lastRunAt: T0,
      lastTaskId: 't1',
      history: [expect.objectContaining({ kind: 'started', detail: 'manual', taskId: 't1' })],
    });
  });

  it.each(['timed', 'manual'])('does not restore a schedule deleted during a %s run', async (kind) => {
    const { deps, schedules, service, tasks } = setup();
    const creation = deferTaskCreation(deps);
    const run = kind === 'timed' ? service.tick() : service.runNow('s1');
    await creation.entered;
    schedules.pop();
    creation.release();

    expect(await run).toEqual(kind === 'timed' ? undefined : { started: true, taskId: 't1' });
    expect(schedules).toEqual([]);
    expect(tasks.map((task) => task.id)).toEqual(['t1']);
    expect(deps.notifyChanged).not.toHaveBeenCalled();
  });

  it.each(['timed', 'manual'])('keeps a cadence edit and its rescheduled cursor after a %s success', async (kind) => {
    const manual = kind === 'manual';
    const { deps, schedules, service } = setup({
      schedules: [makeSchedule({ nextRunAt: manual ? T0 + DAY : T0 })],
    });
    const creation = deferTaskCreation(deps);
    const run = manual ? service.runNow('s1') : service.tick();
    await creation.entered;
    const edited: RecurringSchedule = {
      ...schedules[0],
      cadence: { kind: 'interval', everyMinutes: 30 },
      nextRunAt: T0 + HOUR / 2,
      name: 'Updated schedule',
      template: { ...schedules[0].template, title: 'Updated task title' },
      updatedAt: T0,
    };
    schedules[0] = edited;
    creation.release();
    await run;

    expect(schedules[0]).toEqual({
      ...edited,
      lastRunAt: T0,
      lastTaskId: 't1',
      history: [expect.objectContaining({ kind: 'started', taskId: 't1' })],
    });
  });

  it('keeps an acknowledgement made during a manual run', async () => {
    const prior = { id: 'previous', at: T0 - DAY, kind: 'failed', acknowledged: false } as const;
    const { deps, schedules, service } = setup({
      schedules: [makeSchedule({ nextRunAt: T0 + DAY, history: [prior] })],
    });
    const creation = deferTaskCreation(deps);
    const run = service.runNow('s1');
    await creation.entered;
    schedules[0] = { ...schedules[0], history: [{ ...prior, acknowledged: true }] };
    creation.release();
    await run;

    expect(schedules[0].history).toEqual([
      { ...prior, acknowledged: true },
      expect.objectContaining({ kind: 'started', taskId: 't1', detail: 'manual', acknowledged: false }),
    ]);
  });

  it.each(['paused', 'deleted'])('re-reads a later schedule %s while an earlier one is being created', async (edit) => {
    const { deps, schedules, service, tasks } = setup({ schedules: [makeSchedule(), makeSchedule({ id: 's2' })] });
    const creation = deferTaskCreation(deps);
    const tick = service.tick();
    await creation.entered;
    const paused = { ...schedules[1], enabled: false, nextRunAt: null };
    if (edit === 'paused') schedules[1] = paused;
    else schedules.pop();
    creation.release();
    await tick;

    expect(deps.createTask).toHaveBeenCalledExactlyOnceWith('p1', schedules[0].template, 's1', T0);
    expect(tasks.map((task) => task.id)).toEqual(['t1']);
    expect(schedules.slice(1)).toEqual(edit === 'paused' ? [paused] : []);
  });

  it('does not retry a failed manual writeback as a task creation failure', async () => {
    const { deps, schedules, service, tasks } = setup({ schedules: [makeSchedule({ nextRunAt: T0 + DAY })] });
    vi.mocked(deps.updateSchedule).mockRejectedValueOnce(new Error('write failed'));
    await expect(service.runNow('s1')).rejects.toThrow('write failed');
    expect(tasks.map((task) => task.id)).toEqual(['t1']);
    expect(deps.updateSchedule).toHaveBeenCalledTimes(1);
    expect(schedules[0].history).toEqual([]);
    expect(deps.notifyChanged).not.toHaveBeenCalled();
    await expect(service.runNow('s1')).resolves.toEqual({ started: true, taskId: 't2' });
  });
});

describe('schedule service', () => {
  it('a due schedule adds exactly one queued task', async () => {
    const { deps, service, schedules, tasks } = setup({ maxParallel: 0 });
    await service.tick();
    expect(deps.createTask).toHaveBeenCalledTimes(1);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe('queue');
    expect(schedules[0].lastTaskId).toBe('t1');
    expect(schedules[0].history.map((h) => h.kind)).toEqual(['started']);
    expect(schedules[0].nextRunAt).toBe(T0 + DAY);
    expect(deps.notifyChanged).toHaveBeenCalledWith('p1');
  });

  it('does not start tasks at the parallel limit and starts once a slot frees', async () => {
    const { deps, service, tasks } = setup({ maxParallel: 1 });
    tasks.push({ id: 'other', specId: 'other', status: 'in_progress', createdAt: new Date(0), metadata: {} } as unknown as Task);
    await service.tick();
    expect(tasks.find((t) => t.id === 't1')?.status).toBe('queue');
    expect(deps.startTask).not.toHaveBeenCalled();
    (tasks[0] as { status: string }).status = 'done';
    await service.tick();
    expect(deps.startTask).toHaveBeenCalledWith('t1');
    expect(tasks.find((t) => t.id === 't1')?.status).toBe('in_progress');
  });

  it('adds no task while the previous one is unfinished and records skipped_unfinished', async () => {
    const { deps, service, schedules, tasks, setNow } = setup({ maxParallel: 0 });
    await service.tick();
    setNow(T0 + DAY);
    await service.tick();
    expect(tasks).toHaveLength(1);
    expect(deps.createTask).toHaveBeenCalledTimes(1);
    expect(schedules[0].history.map((h) => h.kind)).toEqual(['started', 'skipped_unfinished']);
    expect(schedules[0].nextRunAt).toBe(T0 + 2 * DAY);
  });

  it('after a 3-day shutdown records one missed entry and creates one task', async () => {
    const { deps, service, schedules, tasks } = setup({ now: T0 + 3 * DAY + HOUR });
    await service.tick();
    expect(tasks).toHaveLength(1);
    expect(deps.createTask).toHaveBeenCalledTimes(1);
    const missed = schedules[0].history.filter((h) => h.kind === 'missed');
    expect(missed).toHaveLength(1);
    expect(missed[0].missedCount).toBe(4);
    expect(missed[0].missedFrom).toBe(T0);
    expect(missed[0].missedTo).toBe(T0 + 3 * DAY);
    expect(missed[0].acknowledged).toBe(false);
    expect(schedules[0].nextRunAt).toBe(T0 + 4 * DAY);
  });

  it('never runs paused schedules', async () => {
    const { deps, service } = setup({ schedules: [makeSchedule({ enabled: false, nextRunAt: null })] });
    await service.tick();
    expect(deps.createTask).not.toHaveBeenCalled();
  });

  it('ignores schedules whose project was deleted', async () => {
    const { deps, service } = setup({ noProject: true });
    await service.tick();
    expect(deps.createTask).not.toHaveBeenCalled();
    expect(deps.updateSchedule).not.toHaveBeenCalled();
  });

  it('records a createTask error, advances, and does not throw', async () => {
    const { deps, service, schedules } = setup();
    (deps.createTask as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('disk full'));
    await expect(service.tick()).resolves.toBeUndefined();
    expect(schedules[0].history).toHaveLength(1);
    expect(schedules[0].history[0].kind).toBe('failed');
    expect(schedules[0].history[0].detail).toBe('disk full');
    expect(schedules[0].nextRunAt).toBe(T0 + DAY);
  });

  it('leaves a task queued when starting fails and retries next tick', async () => {
    const { deps, service, tasks } = setup();
    (deps.startTask as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    await service.tick();
    expect(tasks[0].status).toBe('queue');
    await service.tick();
    expect(tasks[0].status).toBe('in_progress');
  });

  describe('missed-run policy', () => {
    const makeSkipSchedule = (over: Partial<RecurringSchedule> = {}) =>
      makeSchedule({ missedRunPolicy: 'skip', ...over });

    it.each([
      ['absent', makeSchedule()],
      ['unknown', makeSchedule({ missedRunPolicy: 'unknown' as MissedRunPolicy })],
    ] as const)('creates one catch-up for a single late occurrence with an %s policy', async (_label, schedule) => {
      const { deps, service, schedules } = setup({ now: T0 + 10 * 60_000, schedules: [schedule] });
      await service.tick();
      expect(deps.createTask).toHaveBeenCalledTimes(1);
      expect(schedules[0].history.map((entry) => entry.kind)).toEqual(['missed', 'started']);
      expect(schedules[0].history[0].missedCount).toBe(1);
      expect(schedules[0].nextRunAt).toBe(T0 + DAY);
    });

    it('skips a single late occurrence without replacing the last run', async () => {
      const schedule = makeSkipSchedule({ lastTaskId: 'prior', lastRunAt: T0 - DAY });
      const { deps, service, schedules } = setup({ now: T0 + 10 * 60_000, schedules: [schedule] });
      await service.tick();
      expect(deps.createTask).not.toHaveBeenCalled();
      expect(deps.notifyChanged).toHaveBeenCalledWith('p1');
      expect(schedules[0]).toMatchObject({
        nextRunAt: T0 + DAY,
        lastTaskId: 'prior',
        lastRunAt: T0 - DAY,
        history: [{ kind: 'skipped_missed', missedCount: 1, missedFrom: T0, missedTo: T0 }],
      });
    });

    it('skips several missed occurrences in one record and does nothing on a repeated tick', async () => {
      const { deps, service, schedules } = setup({ now: T0 + 3 * DAY + HOUR, schedules: [makeSkipSchedule()] });
      await service.tick();
      await service.tick();
      expect(deps.createTask).not.toHaveBeenCalled();
      expect(deps.updateSchedule).toHaveBeenCalledTimes(1);
      expect(schedules[0]).toMatchObject({
        nextRunAt: T0 + 4 * DAY,
        history: [{ kind: 'skipped_missed', missedCount: 4, missedFrom: T0, missedTo: T0 + 3 * DAY }],
      });
    });

    it('still creates a task within the grace period', async () => {
      const schedule = makeSkipSchedule();
      const { deps, service, schedules } = setup({ now: T0 + 60_000, schedules: [schedule] });
      await service.tick();
      expect(deps.createTask).toHaveBeenCalledTimes(1);
      expect(deps.createTask).toHaveBeenCalledWith('p1', schedule.template, 's1', T0);
      expect(schedules[0].history.map((entry) => entry.kind)).toEqual(['started']);
    });

    it.each(['catch_up', 'skip'] as const)('checks for unfinished tasks before missed runs with policy %s', async (missedRunPolicy) => {
      const schedule = makeSchedule({ missedRunPolicy, lastTaskId: 'prior' });
      const { deps, service, schedules, tasks } = setup({
        now: T0 + DAY + HOUR,
        schedules: [schedule],
        maxParallel: 0,
      });
      tasks.push({ id: 'prior', status: 'queue' } as Task);
      await service.tick();
      expect(deps.createTask).not.toHaveBeenCalled();
      expect(schedules[0]).toMatchObject({
        nextRunAt: T0 + 2 * DAY,
        history: [{ kind: 'skipped_unfinished', taskId: 'prior', detail: '2 due' }],
      });
    });

    it('advances a skipped interval run to the next occurrence on the original grid', async () => {
      const schedule = makeSkipSchedule({ cadence: { kind: 'interval', everyMinutes: 60 } });
      const { deps, service, schedules } = setup({ now: T0 + 3 * HOUR, schedules: [schedule] });
      await service.tick();
      expect(deps.createTask).not.toHaveBeenCalled();
      expect(schedules[0]).toMatchObject({
        nextRunAt: T0 + 4 * HOUR,
        history: [{ kind: 'skipped_missed', missedCount: 4, missedFrom: T0, missedTo: T0 + 3 * HOUR }],
      });
    });

    it('allows Run now during a missed window without rescheduling the automated run itself', async () => {
      const schedule = makeSkipSchedule();
      const now = T0 + 3 * DAY + HOUR;
      const { deps, service, schedules } = setup({ now, schedules: [schedule], maxParallel: 0 });
      await expect(service.runNow('s1')).resolves.toEqual({ started: true, taskId: 't1' });
      expect(deps.createTask).toHaveBeenCalledTimes(1);
      expect(deps.createTask).toHaveBeenCalledWith('p1', schedule.template, 's1', now);
      // Run now saves before calling tick(), which handles the overdue occurrence separately.
      const runNowPatch = vi.mocked(deps.updateSchedule).mock.calls[0][1](schedule);
      expect(runNowPatch).not.toHaveProperty('nextRunAt');
      expect(schedules[0].history.map(({ kind, detail }) => [kind, detail])).toEqual([
        ['started', 'manual'],
        ['skipped_unfinished', '4 due'],
      ]);
    });

    it('enforces the token budget on a task from a skip schedule', async () => {
      const { deps, service, schedules, tokens } = setup({ schedules: [makeSkipSchedule()] });
      await service.tick();
      tokens.value = 1001;
      await service.tick();
      expect(deps.stopTask).toHaveBeenCalledWith('t1');
      expect(schedules[0].history.at(-1)).toMatchObject({ kind: 'budget_exceeded', detail: '1001/1000' });
    });
  });

  describe('runNow', () => {
    it('queues exactly one task and records a manual started entry', async () => {
      const { deps, service, schedules, tasks } = setup({ maxParallel: 0, schedules: [makeSchedule({ nextRunAt: T0 + DAY })] });
      const result = await service.runNow('s1');
      expect(result).toEqual({ started: true, taskId: 't1' });
      expect(deps.createTask).toHaveBeenCalledTimes(1);
      expect(tasks).toHaveLength(1);
      expect(schedules[0].lastTaskId).toBe('t1');
      expect(schedules[0].lastRunAt).toBe(T0);
      expect(schedules[0].history.map((h) => [h.kind, h.detail])).toEqual([['started', 'manual']]);
      expect(deps.notifyChanged).toHaveBeenCalledWith('p1');
    });

    it('promotes the task when a slot is free and leaves it queued otherwise', async () => {
      const free = setup({ maxParallel: 1, schedules: [makeSchedule({ nextRunAt: T0 + DAY })] });
      await free.service.runNow('s1');
      expect(free.tasks[0].status).toBe('in_progress');
      const full = setup({ maxParallel: 0, schedules: [makeSchedule({ nextRunAt: T0 + DAY })] });
      await full.service.runNow('s1');
      expect(full.tasks[0].status).toBe('queue');
    });

    it('refuses while the previous task is unfinished', async () => {
      const { deps, service, schedules } = setup({ maxParallel: 0, schedules: [makeSchedule({ nextRunAt: T0 + DAY })] });
      await service.runNow('s1');
      const result = await service.runNow('s1');
      expect(result).toEqual({ started: false, reason: 'unfinished', taskId: 't1' });
      expect(deps.createTask).toHaveBeenCalledTimes(1);
      const last = schedules[0].history.at(-1);
      expect(last?.kind).toBe('skipped_unfinished');
      expect(last?.detail).toBe('manual');
    });

    it('leaves nextRunAt unchanged, including null for a paused schedule', async () => {
      const due = setup({ maxParallel: 0, schedules: [makeSchedule({ nextRunAt: T0 + DAY })] });
      await due.service.runNow('s1');
      expect(due.schedules[0].nextRunAt).toBe(T0 + DAY);
      const paused = setup({ maxParallel: 0, schedules: [makeSchedule({ enabled: false, nextRunAt: null })] });
      await paused.service.runNow('s1');
      expect(paused.schedules[0].nextRunAt).toBeNull();
      expect(paused.schedules[0].enabled).toBe(false);
      expect(paused.tasks).toHaveLength(1);
    });

    it('returns not_found for an unknown schedule without saving', async () => {
      const { deps, service } = setup();
      expect(await service.runNow('nope')).toEqual({ started: false, reason: 'not_found' });
      expect(deps.updateSchedule).not.toHaveBeenCalled();
      expect(deps.createTask).not.toHaveBeenCalled();
    });

    it('records a createTask rejection as failed and does not throw', async () => {
      const { deps, service, schedules } = setup({ schedules: [makeSchedule({ nextRunAt: T0 + DAY })] });
      (deps.createTask as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('disk full'));
      await expect(service.runNow('s1')).resolves.toEqual({ started: false });
      expect(schedules[0].history.map((h) => [h.kind, h.detail])).toEqual([['failed', 'disk full']]);
      expect(schedules[0].nextRunAt).toBe(T0 + DAY);
    });

    it('a timed tick at the due time adds no second task while the first is unfinished', async () => {
      const { deps, service, schedules, tasks } = setup({ maxParallel: 0 });
      await service.runNow('s1');
      await service.tick();
      expect(tasks).toHaveLength(1);
      expect(deps.createTask).toHaveBeenCalledTimes(1);
      expect(schedules[0].history.map((h) => h.kind)).toEqual(['started', 'skipped_unfinished']);
    });
  });

  describe('token budget', () => {
    const runOne = async (metadata: Record<string, unknown> = {}) => {
      const ctx = setup();
      await ctx.service.tick();
      Object.assign(ctx.tasks[0].metadata as object, metadata);
      return ctx;
    };

    it('keeps a task below budget running', async () => {
      const ctx = await runOne({ tokenBudget: 1000 });
      ctx.tokens.value = 999;
      await ctx.service.tick();
      expect(ctx.deps.stopTask).not.toHaveBeenCalled();
    });

    it('stops at the budget once and records budget_exceeded', async () => {
      const ctx = await runOne({ tokenBudget: 1000 });
      ctx.tokens.value = 1000;
      await ctx.service.tick();
      await ctx.service.tick();
      expect(ctx.deps.stopTask).toHaveBeenCalledTimes(1);
      expect(ctx.deps.stopTask).toHaveBeenCalledWith('t1');
      const kinds = ctx.schedules[0].history.map((h) => h.kind);
      expect(kinds.filter((k) => k === 'budget_exceeded')).toHaveLength(1);
      expect(ctx.schedules[0].history.at(-1)?.detail).toBe('1000/1000');
    });

    it('does not stop a task that finishes while another budget report is being written', async () => {
      const { deps, schedules, service, tasks } = setup({
        schedules: ['s1', 's2'].map((id) => makeSchedule({ id, enabled: false, nextRunAt: null })),
      });
      for (const [id, scheduleId] of [['a', 's1'], ['b', 's2']]) {
        tasks.push({
          id,
          specId: id,
          projectId: 'p1',
          title: id,
          description: '',
          status: 'in_progress',
          metadata: { sourceType: 'schedule', scheduleId, tokenBudget: 100 },
          subtasks: [],
          logs: [],
          createdAt: new Date(T0),
          updatedAt: new Date(T0),
        });
      }
      deps.listTasks = () => [...tasks];
      let taskBTokens = 99;
      vi.mocked(deps.readTaskTokens).mockImplementation((_projectId, specId) => (specId === 'a' ? 140 : taskBTokens));
      const entered = deferred();
      const release = deferred();
      const updateSchedule = deps.updateSchedule;
      deps.updateSchedule = vi.fn<ScheduleServiceDeps['updateSchedule']>(async (id, mutate) => {
        if (id === 's1') {
          entered.resolve();
          await release.promise;
        }
        return updateSchedule(id, mutate);
      });

      const tick = service.tick();
      await entered.promise;
      tasks[1] = { ...tasks[1], status: 'done' };
      taskBTokens = 140;
      release.resolve();
      await tick;

      expect(deps.stopTask).toHaveBeenCalledExactlyOnceWith('a');
      expect(deps.updateSchedule).toHaveBeenCalledExactlyOnceWith('s1', expect.any(Function));
      expect(schedules[0].history.map(({ kind, taskId, detail }) => [kind, taskId, detail])).toEqual([
        ['budget_exceeded', 'a', '140/100'],
      ]);
      expect(schedules[1].history).toEqual([]);
    });

    it('still stops and notifies if the schedule is deleted before the budget append', async () => {
      const { deps, schedules, service, tokens } = await runOne();
      vi.mocked(deps.notifyChanged).mockClear();
      vi.mocked(deps.stopTask).mockImplementationOnce(() => {
        schedules.pop();
      });
      tokens.value = 1000;

      await service.tick();

      expect(deps.stopTask).toHaveBeenCalledExactlyOnceWith('t1');
      expect(deps.updateSchedule).toHaveBeenLastCalledWith('s1', expect.any(Function));
      expect(schedules).toEqual([]);
      expect(deps.notifyChanged).toHaveBeenCalledExactlyOnceWith('p1');
    });

    it('falls back to the template budget when the task has none', async () => {
      const ctx = await runOne();
      ctx.tokens.value = 5000;
      await ctx.service.tick();
      expect(ctx.deps.stopTask).toHaveBeenCalledWith('t1');
    });

    it('never stops non-scheduled tasks', async () => {
      const ctx = setup({ schedules: [makeSchedule({ nextRunAt: T0 + DAY })] });
      ctx.tasks.push({ id: 'x', specId: 'x', status: 'in_progress', createdAt: new Date(0), metadata: { tokenBudget: 1 } } as unknown as Task);
      ctx.tokens.value = 99999;
      await ctx.service.tick();
      expect(ctx.deps.stopTask).not.toHaveBeenCalled();
    });

    it('survives readTaskTokens throwing', async () => {
      const ctx = await runOne({ tokenBudget: 10 });
      (ctx.deps.readTaskTokens as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('disk');
      });
      await expect(ctx.service.tick()).resolves.toBeUndefined();
      expect(ctx.deps.stopTask).not.toHaveBeenCalled();
    });
  });
});

describe('schedule history descriptions', () => {
  const schedule = makeSchedule({ nextRunAt: T0 + DAY });
  const entry = { id: 'r1', at: T0, acknowledged: false };

  it.each<{ record: Partial<ScheduleRunRecord> & Pick<ScheduleRunRecord, 'kind'>; text: string }>([
    { record: { kind: 'missed', missedCount: 2 }, text: 'missed 2 runs, created one catch-up task' },
    {
      record: { kind: 'skipped_missed', missedCount: 1 },
      text: `missed 1 run, skipped (missed runs: skip); next run ${new Date(T0 + DAY).toISOString()}`,
    },
    {
      record: { kind: 'skipped_unfinished', taskId: 't1', detail: 'manual' },
      text: 'skipped, previous task t1 is unfinished (manual)',
    },
    { record: { kind: 'started', taskId: 't1', detail: 'manual' }, text: 'created task t1 (manual)' },
    {
      record: { kind: 'budget_exceeded', taskId: 't1', detail: '1001/1000' },
      text: 'token budget exceeded by task t1 (1001/1000)',
    },
    { record: { kind: 'failed', detail: 'disk full' }, text: 'failed to create a task: disk full' },
  ])('formats $record.kind', ({ record, text }) => {
    expect(describeScheduleRecord(schedule, { ...entry, ...record })).toBe(`Schedule "deps": ${text}`);
  });

  it('does not include a next run for a paused schedule', () => {
    expect(
      describeScheduleRecord({ ...schedule, nextRunAt: null }, { ...entry, kind: 'skipped_missed', missedCount: 1 })
    ).toBe('Schedule "deps": missed 1 run, skipped (missed runs: skip)');
  });

  it('labels absent and unknown policies as catch up, and the explicit opt-out as skip', () => {
    expect(describeMissedRunPolicy(schedule)).toBe('catch up');
    expect(describeMissedRunPolicy({ ...schedule, missedRunPolicy: 'unknown' as MissedRunPolicy })).toBe('catch up');
    expect(describeMissedRunPolicy({ ...schedule, missedRunPolicy: 'skip' })).toBe('skip');
  });
});

describe('schedule service queue lock', () => {
  it('creates nothing and keeps nextRunAt when canRun is false', async () => {
    const h = setup();
    h.deps.canRun = () => false;
    const svc = createScheduleService(h.deps);
    await svc.tick();
    expect(h.deps.createTask).not.toHaveBeenCalled();
    expect(h.schedules[0].nextRunAt).toBe(T0);
    const result = await svc.runNow('s1');
    expect(result).toEqual({ started: false, reason: 'locked' });
    expect(h.deps.createTask).not.toHaveBeenCalled();
    expect(h.schedules[0].nextRunAt).toBe(T0);
  });
});
