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
    saveSchedule: vi.fn((s: RecurringSchedule) => {
      const i = schedules.findIndex((x) => x.id === s.id);
      schedules[i] = s;
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
    expect(deps.saveSchedule).not.toHaveBeenCalled();
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
      expect(deps.saveSchedule).toHaveBeenCalledTimes(1);
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
      expect(deps.saveSchedule).toHaveBeenNthCalledWith(1, expect.objectContaining({ nextRunAt: T0 }));
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
      expect(deps.saveSchedule).not.toHaveBeenCalled();
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
