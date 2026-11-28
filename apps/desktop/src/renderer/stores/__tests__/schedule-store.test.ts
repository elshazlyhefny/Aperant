/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecurringSchedule } from '../../../shared/types/schedule';
import { useScheduleStore } from '../schedule-store';

type ElectronAPI = Window['electronAPI'];
type Result<Method extends keyof ScheduleMocks> = Awaited<ReturnType<ScheduleMocks[Method]>>;
type ListResult = Result<'listSchedules'>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeSchedule(projectId: string, id: string): RecurringSchedule {
  return {
    id,
    projectId,
    name: id,
    enabled: true,
    cadence: { kind: 'daily', time: '09:00' },
    template: { title: 'Audit deps', description: 'Check deps', tokenBudget: 1000 },
    createdAt: 1,
    updatedAt: 1,
    nextRunAt: 2_000_000_000_000,
    history: []
  };
}

const scheduleAPI = {
  listSchedules: vi.fn<ElectronAPI['listSchedules']>(),
  createSchedule: vi.fn<ElectronAPI['createSchedule']>(),
  updateSchedule: vi.fn<ElectronAPI['updateSchedule']>(),
  deleteSchedule: vi.fn<ElectronAPI['deleteSchedule']>(),
  setScheduleEnabled: vi.fn<ElectronAPI['setScheduleEnabled']>(),
  acknowledgeScheduleReports: vi.fn<ElectronAPI['acknowledgeScheduleReports']>(),
  runScheduleNow: vi.fn<ElectronAPI['runScheduleNow']>()
};
type ScheduleMocks = typeof scheduleAPI;
const { listSchedules } = scheduleAPI;
const { getState, setState } = useScheduleStore;
const loadSchedules = (projectId: string) => getState().loadSchedules(projectId);

async function loadProject(row: RecurringSchedule) {
  listSchedules.mockResolvedValueOnce({ success: true, data: [row] });
  await loadSchedules(row.projectId);
}

beforeEach(() => {
  for (const mock of Object.values(scheduleAPI)) mock.mockReset();
  vi.stubGlobal('electronAPI', scheduleAPI);
  setState({
    schedules: [],
    activeProjectId: null,
    isLoading: false,
    error: null,
    loadError: null
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('schedule store loads', () => {
  it.each(['rejection', 'IPC failure'] as const)(
    'ignores a late %s from A after B has loaded',
    async (outcome) => {
      const a = deferred<ListResult>();
      const rowB = makeSchedule('B', 'b1');
      listSchedules
        .mockReturnValueOnce(a.promise)
        .mockResolvedValueOnce({ success: true, data: [rowB] });

      const loadA = loadSchedules('A');
      await loadSchedules('B');

      if (outcome === 'rejection') a.reject(new Error('A list rejected'));
      else a.resolve({ success: false, error: 'A list failed' });
      await loadA;

      expect(useScheduleStore.getState()).toMatchObject({
        activeProjectId: 'B',
        schedules: [rowB],
        isLoading: false,
        error: null,
        loadError: null
      });
    }
  );

  it.each(['success', 'rejection'] as const)(
    'ignores an older same-project %s after the newer load completes',
    async (outcome) => {
      const first = deferred<ListResult>();
      const second = deferred<ListResult>();
      const row2 = makeSchedule('P', 'p2');
      listSchedules.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

      const olderLoad = loadSchedules('P');
      const newerLoad = loadSchedules('P');
      second.resolve({ success: true, data: [row2] });
      await newerLoad;

      if (outcome === 'success') first.resolve({ success: true, data: [makeSchedule('P', 'p1')] });
      else first.reject(new Error('older list rejected'));
      await olderLoad;

      expect(useScheduleStore.getState()).toMatchObject({
        activeProjectId: 'P',
        schedules: [row2],
        isLoading: false,
        error: null,
        loadError: null
      });
    }
  );

  it('ignores a load from the first A activation after switching A -> B -> A', async () => {
    const firstA = deferred<ListResult>();
    const newRow = makeSchedule('A', 'new');
    listSchedules
      .mockReturnValueOnce(firstA.promise)
      .mockResolvedValueOnce({ success: true, data: [makeSchedule('B', 'b1')] })
      .mockResolvedValueOnce({ success: true, data: [newRow] });

    const olderLoad = loadSchedules('A');
    await loadSchedules('B');
    await loadSchedules('A');

    firstA.resolve({ success: true, data: [makeSchedule('A', 'old')] });
    await olderLoad;

    expect(useScheduleStore.getState()).toMatchObject({
      activeProjectId: 'A',
      schedules: [newRow],
      isLoading: false
    });
  });

  it('keeps loading when a superseded request finishes before the latest request', async () => {
    const first = deferred<ListResult>();
    const second = deferred<ListResult>();
    const row2 = makeSchedule('P', 'p2');
    listSchedules.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const olderLoad = loadSchedules('P');
    const newerLoad = loadSchedules('P');
    first.resolve({ success: true, data: [makeSchedule('P', 'p1')] });
    await olderLoad;

    expect(useScheduleStore.getState()).toMatchObject({ schedules: [], isLoading: true });

    second.resolve({ success: true, data: [row2] });
    await newerLoad;
    expect(useScheduleStore.getState()).toMatchObject({ schedules: [row2], isLoading: false });
  });
});

describe('schedule store mutations', () => {
  it('returns a created schedule without inserting it after switching projects', async () => {
    const created = makeSchedule('A', 'created');
    const rowB = makeSchedule('B', 'b1');
    const create = deferred<Result<'createSchedule'>>();
    scheduleAPI.createSchedule.mockReturnValueOnce(create.promise);

    await loadProject(makeSchedule('A', 'a1'));
    const save = getState().createSchedule('A', created);
    await loadProject(rowB);
    setState({ error: 'B action failed' });

    create.resolve({ success: true, data: created });
    expect(await save).toBe(created);
    expect(getState()).toMatchObject({ schedules: [rowB], error: 'B action failed' });
  });

  it('does not insert a schedule created for an inactive project', async () => {
    const created = makeSchedule('A', 'created');
    const rowB = makeSchedule('B', 'b1');
    scheduleAPI.createSchedule.mockResolvedValueOnce({ success: true, data: created });

    await loadProject(rowB);
    expect(await getState().createSchedule('A', created)).toBe(created);
    expect(getState().schedules).toEqual([rowB]);
  });

  it('preserves update and setEnabled results without applying them after switching projects', async () => {
    const rowA = makeSchedule('A', 'a1');
    const rowB = makeSchedule('B', 'b1');
    const updated = { ...rowA, name: 'Updated' };
    const update = deferred<Result<'updateSchedule'>>();
    const toggle = deferred<Result<'setScheduleEnabled'>>();
    scheduleAPI.updateSchedule.mockReturnValueOnce(update.promise);
    scheduleAPI.setScheduleEnabled.mockReturnValueOnce(toggle.promise);

    await loadProject(rowA);
    const save = getState().updateSchedule(rowA.id, updated);
    const disable = getState().setEnabled(rowA.id, false);
    await loadProject(rowB);

    update.resolve({ success: true, data: updated });
    toggle.resolve({ success: true, data: { ...updated, enabled: false } });
    expect(await save).toBe(updated);
    expect(await disable).toBe(true);
    expect(getState().schedules).toEqual([rowB]);
  });

  it('returns failure values without writing action errors to another project', async () => {
    const rowA = makeSchedule('A', 'shared-id');
    const rowB = makeSchedule('B', 'shared-id');
    const update = deferred<Result<'updateSchedule'>>();
    const remove = deferred<Result<'deleteSchedule'>>();
    scheduleAPI.updateSchedule.mockReturnValueOnce(update.promise);
    scheduleAPI.deleteSchedule.mockReturnValueOnce(remove.promise);

    await loadProject(rowA);
    const save = getState().updateSchedule(rowA.id, rowA);
    const deletion = getState().deleteSchedule(rowA.id);
    await loadProject(rowB);

    update.resolve({ success: false, error: 'A update failed' });
    remove.resolve({ success: false, error: 'A deletion failed' });
    expect(await save).toBeNull();
    expect(await deletion).toBe(false);
    expect(getState()).toMatchObject({ schedules: [rowB], error: null });
  });

  it('propagates rejected mutation IPC to the caller', async () => {
    const row = makeSchedule('P', 'p1');
    const failure = new Error('IPC rejected');
    scheduleAPI.acknowledgeScheduleReports.mockRejectedValueOnce(failure);

    await loadProject(row);
    await expect(getState().acknowledgeReports(row.id)).rejects.toBe(failure);
    expect(getState()).toMatchObject({ schedules: [row], error: null });
  });

  it.each(['current', 'switched'] as const)(
    'returns the runNow result and only reloads its owner (%s)',
    async (ownership) => {
      const rowA = makeSchedule('A', 'a1');
      const rowB = makeSchedule('B', 'b1');
      const result = { started: true, taskId: 'task-1' };
      const run = deferred<Result<'runScheduleNow'>>();
      scheduleAPI.runScheduleNow.mockReturnValueOnce(run.promise);

      await loadProject(rowA);
      const start = getState().runNow(rowA.id);
      if (ownership === 'switched') await loadProject(rowB);
      setState({ error: 'Previous action failed' });
      listSchedules.mockClear();
      listSchedules.mockResolvedValueOnce({ success: true, data: [rowA] });

      run.resolve({ success: true, data: result });
      expect(await start).toBe(result);
      if (ownership === 'switched') {
        expect(listSchedules).not.toHaveBeenCalled();
        expect(getState()).toMatchObject({ schedules: [rowB], error: 'Previous action failed' });
      } else {
        expect(listSchedules.mock.calls).toEqual([['A']]);
        expect(getState()).toMatchObject({ schedules: [rowA], error: null });
      }
    }
  );

  it('keeps the local mutation while a refresh supersedes an older list snapshot', async () => {
    const oldRow = makeSchedule('P', 'p1');
    const updatedRow = { ...oldRow, enabled: false };
    const previous = deferred<ListResult>();
    const refresh = deferred<ListResult>();
    listSchedules.mockReturnValueOnce(previous.promise).mockReturnValueOnce(refresh.promise);
    scheduleAPI.setScheduleEnabled.mockResolvedValueOnce({ success: true, data: updatedRow });

    const originalLoad = loadSchedules('P');
    expect(await getState().setEnabled(oldRow.id, false)).toBe(true);
    expect(listSchedules.mock.calls).toEqual([['P'], ['P']]);

    previous.resolve({ success: true, data: [oldRow] });
    await originalLoad;
    expect(getState()).toMatchObject({ schedules: [updatedRow], isLoading: true });

    refresh.resolve({ success: true, data: [updatedRow] });
    await refresh.promise;
    expect(getState()).toMatchObject({ schedules: [updatedRow], isLoading: false });
  });

  it('ignores a deletion from the first A activation after switching A -> B -> A', async () => {
    const row = makeSchedule('A', 'a1');
    const remove = deferred<Result<'deleteSchedule'>>();
    scheduleAPI.deleteSchedule.mockReturnValueOnce(remove.promise);

    await loadProject(row);
    const deletion = getState().deleteSchedule(row.id);
    await loadProject(makeSchedule('B', 'b1'));
    const newRow = { ...row, name: 'New snapshot' };
    await loadProject(newRow);

    remove.resolve({ success: true });
    expect(await deletion).toBe(true);
    expect(getState().schedules).toEqual([newRow]);
  });

  it('applies a current mutation locally without loading when no list is pending', async () => {
    const row = makeSchedule('P', 'p1');
    const updated = { ...row, enabled: false };
    scheduleAPI.setScheduleEnabled.mockResolvedValueOnce({ success: true, data: updated });

    await loadProject(row);
    setState({ error: 'Previous action failed' });
    expect(await getState().setEnabled(row.id, false)).toBe(true);
    expect(listSchedules.mock.calls).toEqual([['P']]);
    expect(getState()).toMatchObject({ schedules: [updated], error: null });
  });

  it.each(['create', 'update', 'toggle', 'acknowledge'] as const)(
    'does not display a foreign schedule returned by %s',
    async (action) => {
      const row = makeSchedule('A', 'shared-id');
      const foreign = makeSchedule('B', 'shared-id');
      const result = { success: true, data: foreign };
      await loadProject(row);

      switch (action) {
        case 'create':
          scheduleAPI.createSchedule.mockResolvedValueOnce(result);
          expect(await getState().createSchedule('A', row)).toBe(foreign);
          break;
        case 'update':
          scheduleAPI.updateSchedule.mockResolvedValueOnce(result);
          expect(await getState().updateSchedule(row.id, row)).toBe(foreign);
          break;
        case 'toggle':
          scheduleAPI.setScheduleEnabled.mockResolvedValueOnce(result);
          expect(await getState().setEnabled(row.id, false)).toBe(true);
          break;
        case 'acknowledge':
          scheduleAPI.acknowledgeScheduleReports.mockResolvedValueOnce(result);
          expect(await getState().acknowledgeReports(row.id)).toBe(true);
          break;
      }
      expect(getState().schedules).toEqual([row]);
    }
  );

  // zeenha fork: main rejects by-ID calls for another project, so each call names the active one.
  it('passes the active project to by-ID calls and sends nothing without one', async () => {
    const row = makeSchedule('A', 'a1');
    const failed = { success: false, error: 'x' };
    scheduleAPI.updateSchedule.mockResolvedValue(failed);
    scheduleAPI.deleteSchedule.mockResolvedValue(failed);
    scheduleAPI.setScheduleEnabled.mockResolvedValue(failed);
    scheduleAPI.acknowledgeScheduleReports.mockResolvedValue(failed);
    scheduleAPI.runScheduleNow.mockResolvedValue(failed);

    const runAll = async () => [
      await getState().updateSchedule(row.id, row),
      await getState().deleteSchedule(row.id),
      await getState().setEnabled(row.id, false),
      await getState().acknowledgeReports(row.id, ['r1']),
      await getState().runNow(row.id)
    ];

    expect(await runAll()).toEqual([null, false, false, false, null]);
    for (const mock of Object.values(scheduleAPI)) expect(mock).not.toHaveBeenCalled();

    await loadProject(row);
    await runAll();
    expect(scheduleAPI.updateSchedule).toHaveBeenCalledWith('A', row.id, row);
    expect(scheduleAPI.deleteSchedule).toHaveBeenCalledWith('A', row.id);
    expect(scheduleAPI.setScheduleEnabled).toHaveBeenCalledWith('A', row.id, false);
    expect(scheduleAPI.acknowledgeScheduleReports).toHaveBeenCalledWith('A', row.id, ['r1']);
    expect(scheduleAPI.runScheduleNow).toHaveBeenCalledWith('A', row.id);
  });
});
