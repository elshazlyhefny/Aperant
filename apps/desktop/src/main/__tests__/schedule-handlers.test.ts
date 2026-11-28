/**
 * zeenha fork: schedule IPC handlers and their real-store run interleavings.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../shared/constants';
import type { RecurringSchedule, ScheduleInput } from '../../shared/types/schedule';
import { registerScheduleHandlers } from '../ipc-handlers/schedule-handlers';
import { createTaskSpec } from '../ipc-handlers/task/create-task';
import { applyTaskStatusUpdate } from '../ipc-handlers/task/execution-handlers';
import { createScheduleFileStore, type ScheduleGuard, type ScheduleMutator } from '../schedule-file-store';

// biome-ignore lint/suspicious/noExplicitAny: handler results are loosely typed in tests
const handlers = new Map<string, (...args: unknown[]) => Promise<any>>();
let stored: RecurringSchedule[] = [];
let userDataDir: string | undefined;
const send = vi.fn();
const getSchedule = vi.fn((id: string) => stored.find((s) => s.id === id));
const insertSchedule = vi.fn(async (schedule: RecurringSchedule) => {
  stored.push(schedule);
  return schedule;
});
// Simulate a competing writer committing before the store acquires its lock.
const beforeUpdate = vi.fn();
const applyMutation = vi.fn((mutator: ScheduleMutator, current: RecurringSchedule) => mutator(current));
const updateSchedule = vi.fn(async (id: string, mutator: ScheduleMutator) => {
  beforeUpdate();
  const i = stored.findIndex((s) => s.id === id);
  if (i === -1) return undefined;
  stored[i] = { ...stored[i], ...applyMutation(mutator, stored[i]) };
  return stored[i];
});
const deleteSchedule = vi.fn(async (id: string, guard?: ScheduleGuard) => {
  const i = stored.findIndex((s) => s.id === id);
  if (i === -1) return undefined;
  guard?.(stored[i]);
  return stored.splice(i, 1)[0];
});

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => handlers.set(channel, fn) },
}));

vi.mock('../schedule-store', async (importOriginal) => {
  const realStore = await importOriginal<typeof import('../schedule-store')>();
  // Use the actual Electron facade when a test provides a temporary userData path.
  return {
    ...realStore,
    listSchedules: (projectId?: string) =>
      userDataDir ? realStore.listSchedules(projectId) : stored.filter((s) => !projectId || s.projectId === projectId),
    getSchedule: (id: string) => (userDataDir ? realStore.getSchedule(id) : getSchedule(id)),
    insertSchedule: (schedule: RecurringSchedule) =>
      userDataDir ? realStore.insertSchedule(schedule) : insertSchedule(schedule),
    updateSchedule: (id: string, mutator: ScheduleMutator) =>
      userDataDir ? realStore.updateSchedule(id, mutator) : updateSchedule(id, mutator),
    deleteSchedule: (id: string, guard?: ScheduleGuard) =>
      userDataDir ? realStore.deleteSchedule(id, guard) : deleteSchedule(id, guard),
  };
});

vi.mock('../desktop-queue-lock', () => ({ ensureQueueLock: () => ({ ok: true }) }));

vi.mock('../project-store', () => ({
  projectStore: {
    getProject: (id: string) => (id === 'p1' ? { id: 'p1', path: '/repo' } : undefined),
    getTasks: () => [],
    invalidateTasksCache: vi.fn(),
  },
}));

vi.mock('../ipc-handlers/task/create-task', () => ({ createTaskSpec: vi.fn() }));
vi.mock('../ipc-handlers/task/execution-handlers', () => ({ applyTaskStatusUpdate: vi.fn(), stopTask: vi.fn() }));
const runNow = vi.fn();

const registerHandlers = () => {
  const win = { isDestroyed: () => false, webContents: { send } };
  return registerScheduleHandlers({ isRunning: () => false } as never, () => win as never);
};

const input = (over: Partial<ScheduleInput> = {}): ScheduleInput => ({
  projectId: 'p1',
  name: 'Weekly deps',
  cadence: { kind: 'daily', time: '09:00' },
  template: { title: 'Update deps', description: 'Update all', tokenBudget: 1000 },
  ...over,
});

const call = (channel: string, ...args: unknown[]) => {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`no handler ${channel}`);
  return fn({}, ...args);
};

describe('schedule handlers', () => {
  beforeEach(() => {
    handlers.clear();
    stored = [];
    vi.clearAllMocks();
    beforeUpdate.mockReset();
    runNow.mockReset();
    vi.spyOn(registerHandlers(), 'runNow').mockImplementation(runNow);
  });

  it('creates a schedule with nextRunAt in the future and notifies', async () => {
    const res = await call(IPC_CHANNELS.SCHEDULE_CREATE, 'p1', input({ projectId: 'other', name: ' Weekly deps ' }));
    expect(res.success).toBe(true);
    expect(insertSchedule).toHaveBeenCalledExactlyOnceWith(res.data);
    expect(updateSchedule).not.toHaveBeenCalled();
    expect(res.data).toMatchObject({ projectId: 'p1', name: 'Weekly deps', history: [] });
    expect(res.data.nextRunAt).toBeGreaterThan(Date.now() - 1000);
    expect(stored).toHaveLength(1);
    expect(stored[0]).not.toHaveProperty('missedRunPolicy');
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.SCHEDULE_CHANGED, { projectId: 'p1' });
  });

  it('creates a schedule with the skip policy', async () => {
    const res = await call(IPC_CHANNELS.SCHEDULE_CREATE, 'p1', input({ missedRunPolicy: 'skip' }));
    expect(res.success).toBe(true);
    expect(res.data.missedRunPolicy).toBe('skip');
    expect(stored[0].missedRunPolicy).toBe('skip');
  });

  it.each(['replay', '', null])('rejects an invalid missed-run policy (%j) on create', async (missedRunPolicy) => {
    const res = await call(IPC_CHANNELS.SCHEDULE_CREATE, 'p1', { ...input(), missedRunPolicy });
    expect(res).toEqual({ success: false, error: 'Missed-run policy must be catch_up or skip' });
    expect(stored).toHaveLength(0);
  });

  it('rejects a bad cadence', async () => {
    const res = await call(IPC_CHANNELS.SCHEDULE_CREATE, 'p1', input({ cadence: { kind: 'daily', time: '25:99' } }));
    expect(res.success).toBe(false);
    expect(stored).toHaveLength(0);
  });

  it('rejects an interval below 15 minutes', async () => {
    const res = await call(IPC_CHANNELS.SCHEDULE_CREATE, 'p1', input({ cadence: { kind: 'interval', everyMinutes: 5 } }));
    expect(res.success).toBe(false);
  });

  it('rejects a missing or non-positive token budget', async () => {
    const noBudget = input({ template: { title: 't', description: 'd' } as never });
    expect((await call(IPC_CHANNELS.SCHEDULE_CREATE, 'p1', noBudget)).success).toBe(false);
    const zero = input({ template: { title: 't', description: 'd', tokenBudget: 0 } });
    expect((await call(IPC_CHANNELS.SCHEDULE_CREATE, 'p1', zero)).success).toBe(false);
    const frac = input({ template: { title: 't', description: 'd', tokenBudget: 1.5 } });
    expect((await call(IPC_CHANNELS.SCHEDULE_CREATE, 'p1', frac)).success).toBe(false);
  });

  it('rejects empty name, title and description', async () => {
    expect((await call(IPC_CHANNELS.SCHEDULE_CREATE, 'p1', input({ name: ' ' }))).success).toBe(false);
    const t = input({ template: { title: '', description: 'd', tokenBudget: 1 } });
    expect((await call(IPC_CHANNELS.SCHEDULE_CREATE, 'p1', t)).success).toBe(false);
    const d = input({ template: { title: 't', description: ' ', tokenBudget: 1 } });
    expect((await call(IPC_CHANNELS.SCHEDULE_CREATE, 'p1', d)).success).toBe(false);
  });

  it('rejects an unknown project', async () => {
    expect((await call(IPC_CHANNELS.SCHEDULE_CREATE, 'nope', input())).success).toBe(false);
  });

  it('only changes enabled, updatedAt and nextRunAt when pausing or resuming', async () => {
    const { data } = await call(IPC_CHANNELS.SCHEDULE_CREATE, 'p1', input());
    send.mockClear();
    const paused = await call(IPC_CHANNELS.SCHEDULE_SET_ENABLED, 'p1', data.id, false);
    const pausePatch = { enabled: false, updatedAt: paused.data.updatedAt, nextRunAt: null };
    expect(applyMutation).toHaveReturnedWith(pausePatch);
    expect(paused.data).toEqual({ ...data, ...pausePatch });

    beforeUpdate.mockImplementationOnce(() => {
      stored[0] = { ...stored[0], cadence: { kind: 'interval', everyMinutes: 45 } };
    });
    const resumed = await call(IPC_CHANNELS.SCHEDULE_SET_ENABLED, 'p1', data.id, true);
    const resumePatch = {
      enabled: true,
      updatedAt: resumed.data.updatedAt,
      nextRunAt: resumed.data.updatedAt + 45 * 60_000,
    };
    expect(applyMutation).toHaveLastReturnedWith(resumePatch);
    expect(resumed.data).toEqual({
      ...paused.data,
      cadence: { kind: 'interval', everyMinutes: 45 },
      ...resumePatch,
    });
    expect(send.mock.calls).toEqual([
      [IPC_CHANNELS.SCHEDULE_CHANGED, { projectId: 'p1' }],
      [IPC_CHANNELS.SCHEDULE_CHANGED, { projectId: 'p1' }],
    ]);
  });

  it('edits settings without resetting run data appended before it takes the lock', async () => {
    const { data } = await call(IPC_CHANNELS.SCHEDULE_CREATE, 'p1', input());
    send.mockClear();
    const runFields = {
      lastRunAt: 123,
      lastTaskId: 't1',
      history: [{ id: 'run', at: 123, kind: 'started', taskId: 't1', acknowledged: false }],
    } satisfies Partial<RecurringSchedule>;
    beforeUpdate.mockImplementationOnce(() => {
      stored[0] = { ...stored[0], ...runFields };
    });
    const updatedInput = input({
      projectId: 'other',
      enabled: false,
      name: ' Renamed ',
      cadence: { kind: 'interval', everyMinutes: 30 },
      template: { title: ' New title ', description: 'New instructions', tokenBudget: 2000 },
    });
    const edited = await call(IPC_CHANNELS.SCHEDULE_UPDATE, 'p1', data.id, updatedInput);
    const editPatch = {
      name: 'Renamed',
      cadence: updatedInput.cadence,
      template: { ...updatedInput.template, title: 'New title' },
      updatedAt: edited.data.updatedAt,
      nextRunAt: edited.data.updatedAt + 30 * 60_000,
    };
    expect(edited.success).toBe(true);
    expect(applyMutation).toHaveReturnedWith(editPatch);
    expect(edited.data).toEqual({ ...data, ...runFields, ...editPatch });
    expect(stored[0]).not.toHaveProperty('missedRunPolicy');
    expect(send).toHaveBeenCalledExactlyOnceWith(IPC_CHANNELS.SCHEDULE_CHANGED, { projectId: 'p1' });
  });

  it('updates the policy from catch_up to skip and back', async () => {
    const { data } = await call(IPC_CHANNELS.SCHEDULE_CREATE, 'p1', input({ missedRunPolicy: 'catch_up' }));
    expect(stored[0].missedRunPolicy).toBe('catch_up');

    for (const missedRunPolicy of ['skip', 'catch_up'] as const) {
      const res = await call(IPC_CHANNELS.SCHEDULE_UPDATE, 'p1', data.id, input({ missedRunPolicy }));
      expect(res.success).toBe(true);
      expect(res.data.missedRunPolicy).toBe(missedRunPolicy);
      expect(stored[0].missedRunPolicy).toBe(missedRunPolicy);
    }
  });

  it('keeps the stored policy when an edit omits it', async () => {
    const { data } = await call(IPC_CHANNELS.SCHEDULE_CREATE, 'p1', input({ missedRunPolicy: 'skip' }));
    const res = await call(IPC_CHANNELS.SCHEDULE_UPDATE, 'p1', data.id, input({ name: 'Renamed' }));
    expect(res.success).toBe(true);
    expect(stored[0]).toMatchObject({ name: 'Renamed', missedRunPolicy: 'skip' });
  });

  it('rejects an invalid policy edit without changing the schedule', async () => {
    const { data } = await call(IPC_CHANNELS.SCHEDULE_CREATE, 'p1', input({ missedRunPolicy: 'skip' }));
    const res = await call(IPC_CHANNELS.SCHEDULE_UPDATE, 'p1', data.id, { ...input(), missedRunPolicy: 'replay' });
    expect(res).toEqual({ success: false, error: 'Missed-run policy must be catch_up or skip' });
    expect(stored[0]).toEqual(data);
  });

  it('keeps a schedule paused when edited, even if it was paused just before the edit takes the lock', async () => {
    const { data } = await call(IPC_CHANNELS.SCHEDULE_CREATE, 'p1', input());
    beforeUpdate.mockImplementationOnce(() => {
      stored[0] = { ...stored[0], enabled: false, nextRunAt: null };
    });
    const edited = await call(IPC_CHANNELS.SCHEDULE_UPDATE, 'p1', data.id, input({ name: 'Renamed', enabled: true }));
    expect(edited.data).toMatchObject({ name: 'Renamed', enabled: false, nextRunAt: null });
  });

  it('rejects an invalid edit without a write or notification', async () => {
    const { data } = await call(IPC_CHANNELS.SCHEDULE_CREATE, 'p1', input());
    send.mockClear();
    const res = await call(IPC_CHANNELS.SCHEDULE_UPDATE, 'p1', data.id, input({ cadence: { kind: 'interval', everyMinutes: 1 } }));
    expect(res.success).toBe(false);
    expect(stored[0]).toEqual(data);
    expect(send).not.toHaveBeenCalled();
  });

  it('deletes without a pre-read and notifies using the removed schedule', async () => {
    const { data } = await call(IPC_CHANNELS.SCHEDULE_CREATE, 'p1', input());
    stored.push({ ...data, id: 'unrelated' });
    send.mockClear();
    expect(await call(IPC_CHANNELS.SCHEDULE_DELETE, 'p1', data.id)).toEqual({ success: true });
    expect(deleteSchedule).toHaveBeenCalledExactlyOnceWith(data.id, expect.any(Function));
    expect(getSchedule).not.toHaveBeenCalled();
    expect(stored).toEqual([{ ...data, id: 'unrelated' }]);
    expect(send).toHaveBeenCalledExactlyOnceWith(IPC_CHANNELS.SCHEDULE_CHANGED, { projectId: 'p1' });
  });

  it.each([
    [IPC_CHANNELS.SCHEDULE_UPDATE, input()],
    [IPC_CHANNELS.SCHEDULE_UPDATE, input({ name: '' })],
    [IPC_CHANNELS.SCHEDULE_SET_ENABLED, true],
    [IPC_CHANNELS.SCHEDULE_ACK_REPORTS, ['report']],
    [IPC_CHANNELS.SCHEDULE_DELETE, undefined],
  ])('%s returns not found without a mutation or change event for a missing row', async (channel, arg) => {
    const { data } = await call(IPC_CHANNELS.SCHEDULE_CREATE, 'p1', input());
    send.mockClear();
    expect(await call(channel, 'p1', 'missing', arg)).toEqual({ success: false, error: 'Schedule not found' });
    expect(getSchedule).not.toHaveBeenCalled();
    expect(applyMutation).not.toHaveBeenCalled();
    expect(stored).toEqual([data]);
    expect(send).not.toHaveBeenCalled();
  });

  // zeenha fork: by-ID handlers enforce the caller's project in main, not only in the renderer.
  it.each([
    [IPC_CHANNELS.SCHEDULE_UPDATE, input({ name: 'Hijacked' })],
    [IPC_CHANNELS.SCHEDULE_SET_ENABLED, false],
    [IPC_CHANNELS.SCHEDULE_ACK_REPORTS, undefined],
    [IPC_CHANNELS.SCHEDULE_DELETE, undefined],
    [IPC_CHANNELS.SCHEDULE_RUN_NOW, undefined],
  ])('%s rejects a schedule of another project without a write or change event', async (channel, arg) => {
    const { data } = await call(IPC_CHANNELS.SCHEDULE_CREATE, 'p1', input());
    stored[0] = { ...stored[0], history: [{ id: 'r', at: 1, kind: 'missed', acknowledged: false }] };
    const before = structuredClone(stored);
    send.mockClear();
    for (const projectId of ['p2', undefined]) {
      expect(await call(channel, projectId, data.id, arg)).toEqual({
        success: false,
        error: 'Schedule belongs to a different project',
      });
    }
    expect(stored).toEqual(before);
    expect(runNow).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('lists schedules per project and nothing for a removed project', async () => {
    await call(IPC_CHANNELS.SCHEDULE_CREATE, 'p1', input());
    expect((await call(IPC_CHANNELS.SCHEDULE_LIST, 'p1')).data).toHaveLength(1);
    stored.push({ ...stored[0], id: 'orphan', projectId: 'gone' });
    expect((await call(IPC_CHANNELS.SCHEDULE_LIST, 'gone')).data).toEqual([]);
  });

  describe('run now', () => {
    it('delegates to the service and returns its result', async () => {
      const { data } = await call(IPC_CHANNELS.SCHEDULE_CREATE, 'p1', input());
      runNow.mockResolvedValue({ started: true, taskId: 't1' });
      const res = await call(IPC_CHANNELS.SCHEDULE_RUN_NOW, 'p1', data.id);
      expect(runNow).toHaveBeenCalledWith(data.id);
      expect(res).toEqual({ success: true, data: { started: true, taskId: 't1' } });
    });

    it('rejects an unknown id without calling the service', async () => {
      const res = await call(IPC_CHANNELS.SCHEDULE_RUN_NOW, 'p1', 'nope');
      expect(res).toEqual({ success: false, error: 'Schedule not found' });
      expect((await call(IPC_CHANNELS.SCHEDULE_RUN_NOW, 'p1', '')).success).toBe(false);
      expect(runNow).not.toHaveBeenCalled();
    });

    it('returns an unfinished result as success with started false', async () => {
      const { data } = await call(IPC_CHANNELS.SCHEDULE_CREATE, 'p1', input());
      runNow.mockResolvedValue({ started: false, reason: 'unfinished', taskId: 't1' });
      const res = await call(IPC_CHANNELS.SCHEDULE_RUN_NOW, 'p1', data.id);
      expect(res.success).toBe(true);
      expect(res.data.started).toBe(false);
      expect(res.data.reason).toBe('unfinished');
    });
  });

  it('acknowledges only selected reports, or all reports present under the lock', async () => {
    const { data } = await call(IPC_CHANNELS.SCHEDULE_CREATE, 'p1', input());
    send.mockClear();
    const a = { id: 'a', at: 1, kind: 'missed', acknowledged: false } as const;
    const b = { id: 'b', at: 2, kind: 'failed', acknowledged: false } as const;
    const c = { id: 'c', at: 3, kind: 'budget_exceeded', acknowledged: false } as const;
    beforeUpdate.mockImplementationOnce(() => {
      stored[0] = { ...stored[0], history: [a, b] };
    });
    const some = await call(IPC_CHANNELS.SCHEDULE_ACK_REPORTS, 'p1', data.id, ['a', 'c']);
    const somePatch = { history: [{ ...a, acknowledged: true }, b] };
    expect(applyMutation).toHaveLastReturnedWith(somePatch);
    expect(some.data).toEqual({ ...data, ...somePatch });

    // Requesting a report that doesn't exist yet does not acknowledge it later.
    stored[0] = { ...stored[0], history: [...stored[0].history, c] };
    expect(stored[0].history[2].acknowledged).toBe(false);
    const all = await call(IPC_CHANNELS.SCHEDULE_ACK_REPORTS, 'p1', data.id);
    const allPatch = { history: [a, b, c].map((r) => ({ ...r, acknowledged: true })) };
    expect(applyMutation).toHaveLastReturnedWith(allPatch);
    expect(all.data).toEqual({ ...data, ...allPatch });
    expect(send.mock.calls).toEqual([
      [IPC_CHANNELS.SCHEDULE_CHANGED, { projectId: 'p1' }],
      [IPC_CHANNELS.SCHEDULE_CHANGED, { projectId: 'p1' }],
    ]);
  });
});

describe('schedule handler interleavings with a real file', () => {
  let disk: ReturnType<typeof createScheduleFileStore>;
  const taskId = 'created-task';
  const cadence = { kind: 'interval', everyMinutes: 30 } as const;

  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    userDataDir = mkdtempSync(join(tmpdir(), 'schedule-handlers-'));
    disk = createScheduleFileStore(join(userDataDir, 'schedules.json'));
    vi.mocked(applyTaskStatusUpdate).mockResolvedValue({ success: true });
    registerHandlers();
  });

  afterEach(() => {
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
    userDataDir = undefined;
  });

  async function runDuring<T>(id: string, mutate: () => Promise<T>): Promise<T> {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(createTaskSpec).mockImplementationOnce(async (projectId, title, description, metadata) => {
      enter();
      await released;
      const now = new Date();
      return {
        success: true,
        data: {
          id: taskId,
          specId: taskId,
          projectId,
          title,
          description,
          metadata,
          status: 'queue',
          subtasks: [],
          logs: [],
          createdAt: now,
          updatedAt: now,
        },
      };
    });

    send.mockClear();
    const run = call(IPC_CHANNELS.SCHEDULE_RUN_NOW, 'p1', id);
    let committed: T;
    try {
      await Promise.race([
        entered,
        run.then((result) => {
          throw new Error(`Run finished before entering task creation: ${JSON.stringify(result)}`);
        }),
      ]);
      // Each IPC mutation must commit while the task creator is still blocked.
      committed = await mutate();
    } finally {
      release();
      await run;
    }
    expect(await run).toEqual({ success: true, data: { started: true, taskId } });
    expect(createTaskSpec).toHaveBeenCalledTimes(1);
    expect(applyTaskStatusUpdate).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.any(Function), taskId, 'queue');
    return committed;
  }

  it.each([false, true])('keeps edits and acknowledgement after a run (pause: %s)', async (pause) => {
    const created = await call(IPC_CHANNELS.SCHEDULE_CREATE, 'p1', input({ cadence }));
    expect(created.success).toBe(true);
    const { id } = created.data;
    const report = { id: 'old-report', at: 1, kind: 'missed', acknowledged: false } as const;
    await disk.updateSchedule(id, () => ({ history: [report] }));

    const edit = input({
      name: 'New name',
      cadence: { kind: 'interval', everyMinutes: 45 },
      template: { title: 'New title', description: 'New instructions', tokenBudget: 2000 },
    });
    const committed = await runDuring(id, async () => {
      const edited = await call(IPC_CHANNELS.SCHEDULE_UPDATE, 'p1', id, edit);
      expect(edited.success).toBe(true);
      expect(edited.data.nextRunAt).toBe(edited.data.updatedAt + 45 * 60_000);
      if (pause) {
        const paused = await call(IPC_CHANNELS.SCHEDULE_SET_ENABLED, 'p1', id, false);
        expect(paused.success).toBe(true);
      }
      const acked = await call(IPC_CHANNELS.SCHEDULE_ACK_REPORTS, 'p1', id, [report.id]);
      expect(acked.success).toBe(true);
      const current = disk.getSchedule(id);
      expect(current).toMatchObject({
        name: edit.name,
        cadence: edit.cadence,
        template: edit.template,
        nextRunAt: pause ? null : edited.data.nextRunAt,
        enabled: !pause,
        history: [{ ...report, acknowledged: true }],
      });
      return current;
    });

    const scheduledFor = vi.mocked(createTaskSpec).mock.calls[0]?.[3]?.scheduledFor;
    expect(scheduledFor).toEqual(expect.any(Number));
    expect(disk.getSchedule(id)).toEqual({
      ...committed,
      lastRunAt: scheduledFor,
      lastTaskId: taskId,
      history: [
        { ...report, acknowledged: true },
        { id: expect.any(String), kind: 'started', at: scheduledFor, detail: 'manual', taskId, acknowledged: false },
      ],
    });
  });

  it('rejects cross-project edits and deletes under the real file lock', async () => {
    const created = await call(IPC_CHANNELS.SCHEDULE_CREATE, 'p1', input({ cadence }));
    const { id } = created.data;
    send.mockClear();
    const error = { success: false, error: 'Schedule belongs to a different project' };
    expect(await call(IPC_CHANNELS.SCHEDULE_UPDATE, 'p2', id, input({ name: 'Hijacked' }))).toEqual(error);
    expect(await call(IPC_CHANNELS.SCHEDULE_SET_ENABLED, 'p2', id, false)).toEqual(error);
    expect(await call(IPC_CHANNELS.SCHEDULE_DELETE, 'p2', id)).toEqual(error);
    expect(disk.listSchedules()).toEqual([created.data]);
    expect(send).not.toHaveBeenCalled();
    expect(await call(IPC_CHANNELS.SCHEDULE_DELETE, 'p1', id)).toEqual({ success: true });
    expect(disk.listSchedules()).toEqual([]);
  });

  it('does not recreate a deleted schedule or notify again when task creation finishes', async () => {
    const created = await call(IPC_CHANNELS.SCHEDULE_CREATE, 'p1', input({ cadence }));
    expect(created.success).toBe(true);
    const { id, projectId } = created.data;

    await runDuring(id, async () => {
      expect(disk.getSchedule(id)).toEqual(created.data);
      expect(await call(IPC_CHANNELS.SCHEDULE_DELETE, 'p1', id)).toEqual({ success: true });
      expect(disk.getSchedule(id)).toBeUndefined();
      expect(send).toHaveBeenCalledExactlyOnceWith(IPC_CHANNELS.SCHEDULE_CHANGED, { projectId });
    });

    expect(disk.listSchedules()).toEqual([]);
    expect(send).toHaveBeenCalledExactlyOnceWith(IPC_CHANNELS.SCHEDULE_CHANGED, { projectId });
  });
});
