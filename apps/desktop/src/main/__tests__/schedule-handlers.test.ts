/**
 * zeenha fork: schedule IPC handlers, with the store and task functions mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecurringSchedule, ScheduleInput } from '../../shared/types/schedule';
import { IPC_CHANNELS } from '../../shared/constants';

// biome-ignore lint/suspicious/noExplicitAny: handler results are loosely typed in tests
const handlers = new Map<string, (...args: unknown[]) => Promise<any>>();
let stored: RecurringSchedule[] = [];
const send = vi.fn();
const deleteTask = vi.fn();

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => handlers.set(channel, fn) },
}));

vi.mock('../schedule-store', () => ({
  listSchedules: (projectId?: string) => stored.filter((s) => !projectId || s.projectId === projectId),
  getSchedule: (id: string) => stored.find((s) => s.id === id),
  saveSchedule: (s: RecurringSchedule) => {
    const i = stored.findIndex((x) => x.id === s.id);
    if (i >= 0) stored[i] = s;
    else stored.push(s);
    return s;
  },
  removeSchedule: (id: string) => {
    stored = stored.filter((s) => s.id !== id);
    return true;
  },
}));

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
vi.mock('../schedule-service', () => ({
  createScheduleService: () => ({ start: vi.fn(), stop: vi.fn(), tick: vi.fn(), onAgentExit: vi.fn(), runNow }),
  readTaskTokensFromDisk: () => 0,
}));

import { registerScheduleHandlers } from '../ipc-handlers/schedule-handlers';

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
    send.mockClear();
    deleteTask.mockClear();
    runNow.mockReset();
    const win = { isDestroyed: () => false, webContents: { send } };
    registerScheduleHandlers({ isRunning: () => false } as never, () => win as never);
  });

  it('creates a schedule with nextRunAt in the future and notifies', async () => {
    const res = await call(IPC_CHANNELS.SCHEDULE_CREATE, 'p1', input());
    expect(res.success).toBe(true);
    expect(res.data.nextRunAt).toBeGreaterThan(Date.now() - 1000);
    expect(stored).toHaveLength(1);
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.SCHEDULE_CHANGED, { projectId: 'p1' });
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

  it('pausing clears nextRunAt and resuming recomputes it from now', async () => {
    const { data } = await call(IPC_CHANNELS.SCHEDULE_CREATE, 'p1', input());
    const paused = await call(IPC_CHANNELS.SCHEDULE_SET_ENABLED, data.id, false);
    expect(paused.data.enabled).toBe(false);
    expect(paused.data.nextRunAt).toBeNull();
    const resumed = await call(IPC_CHANNELS.SCHEDULE_SET_ENABLED, data.id, true);
    expect(resumed.data.enabled).toBe(true);
    expect(resumed.data.nextRunAt).toBeGreaterThan(Date.now() - 1000);
  });

  it('edit recomputes nextRunAt, but keeps a paused schedule paused', async () => {
    const { data } = await call(IPC_CHANNELS.SCHEDULE_CREATE, 'p1', input());
    const edited = await call(
      IPC_CHANNELS.SCHEDULE_UPDATE,
      data.id,
      input({ cadence: { kind: 'interval', everyMinutes: 30 } })
    );
    expect(edited.success).toBe(true);
    expect(edited.data.cadence).toEqual({ kind: 'interval', everyMinutes: 30 });
    expect(edited.data.nextRunAt).toBeGreaterThan(Date.now() + 29 * 60_000);

    await call(IPC_CHANNELS.SCHEDULE_SET_ENABLED, data.id, false);
    const pausedEdit = await call(IPC_CHANNELS.SCHEDULE_UPDATE, data.id, input({ name: 'Renamed' }));
    expect(pausedEdit.data.nextRunAt).toBeNull();
    expect(pausedEdit.data.name).toBe('Renamed');
  });

  it('rejects an invalid edit and leaves the schedule unchanged', async () => {
    const { data } = await call(IPC_CHANNELS.SCHEDULE_CREATE, 'p1', input());
    const res = await call(IPC_CHANNELS.SCHEDULE_UPDATE, data.id, input({ cadence: { kind: 'interval', everyMinutes: 1 } }));
    expect(res.success).toBe(false);
    expect(stored[0].cadence).toEqual({ kind: 'daily', time: '09:00' });
  });

  it('delete removes only the schedule and leaves tasks alone', async () => {
    const { data } = await call(IPC_CHANNELS.SCHEDULE_CREATE, 'p1', input());
    const res = await call(IPC_CHANNELS.SCHEDULE_DELETE, data.id);
    expect(res.success).toBe(true);
    expect(stored).toHaveLength(0);
    expect(deleteTask).not.toHaveBeenCalled();
    expect((await call(IPC_CHANNELS.SCHEDULE_DELETE, data.id)).success).toBe(false);
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
      const res = await call(IPC_CHANNELS.SCHEDULE_RUN_NOW, data.id);
      expect(runNow).toHaveBeenCalledWith(data.id);
      expect(res).toEqual({ success: true, data: { started: true, taskId: 't1' } });
    });

    it('rejects an unknown id without calling the service', async () => {
      const res = await call(IPC_CHANNELS.SCHEDULE_RUN_NOW, 'nope');
      expect(res).toEqual({ success: false, error: 'Schedule not found' });
      expect((await call(IPC_CHANNELS.SCHEDULE_RUN_NOW, '')).success).toBe(false);
      expect(runNow).not.toHaveBeenCalled();
    });

    it('returns an unfinished result as success with started false', async () => {
      const { data } = await call(IPC_CHANNELS.SCHEDULE_CREATE, 'p1', input());
      runNow.mockResolvedValue({ started: false, reason: 'unfinished', taskId: 't1' });
      const res = await call(IPC_CHANNELS.SCHEDULE_RUN_NOW, data.id);
      expect(res.success).toBe(true);
      expect(res.data.started).toBe(false);
      expect(res.data.reason).toBe('unfinished');
    });
  });

  it('acknowledges all or selected reports', async () => {
    const { data } = await call(IPC_CHANNELS.SCHEDULE_CREATE, 'p1', input());
    stored[0] = {
      ...stored[0],
      history: [
        { id: 'a', at: 1, kind: 'missed', acknowledged: false },
        { id: 'b', at: 2, kind: 'missed', acknowledged: false },
      ],
    };
    const some = await call(IPC_CHANNELS.SCHEDULE_ACK_REPORTS, data.id, ['a']);
    expect(some.data.history.map((r: { acknowledged: boolean }) => r.acknowledged)).toEqual([true, false]);
    const all = await call(IPC_CHANNELS.SCHEDULE_ACK_REPORTS, data.id);
    expect(all.data.history.every((r: { acknowledged: boolean }) => r.acknowledged)).toBe(true);
  });
});
