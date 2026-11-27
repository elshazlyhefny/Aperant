import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
// @ts-expect-error - no types available for proper-lockfile
import * as lockfile from 'proper-lockfile';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SCHEDULE_HISTORY, type RecurringSchedule, type ScheduleRunRecord } from '../../shared/types/schedule';
import { createScheduleFileStore } from '../schedule-file-store';

vi.mock('proper-lockfile', { spy: true });

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sched-store-'));
  file = path.join(dir, 'nested', 'schedules.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function make(id: string, projectId = 'p1', history: ScheduleRunRecord[] = []): RecurringSchedule {
  return {
    id,
    projectId,
    name: 'Example',
    enabled: true,
    cadence: { kind: 'daily', time: '09:00' },
    template: { title: 't', description: 'd', tokenBudget: 1_000 },
    createdAt: 1,
    updatedAt: 1,
    nextRunAt: 100,
    history,
  };
}

describe('createScheduleFileStore', () => {
  it('inserts into a missing nested file and resolves the path once per transaction', async () => {
    const getPath = vi.fn(() => file);
    const store = createScheduleFileStore(getPath);
    expect(getPath).not.toHaveBeenCalled();
    expect(store.listSchedules()).toEqual([]);
    getPath.mockClear();

    const first = make('a');
    expect(await store.insertSchedule(first)).toEqual(first);
    expect(getPath).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ version: 1, schedules: [first] });
    await store.insertSchedule(make('b', 'p2'));
    expect(store.getSchedule('a')).toEqual(first);
    expect(store.listSchedules('p2').map((s) => s.id)).toEqual(['b']);
  });

  it('loads a legacy schedule unchanged and round-trips a skip policy', async () => {
    const legacy: RecurringSchedule = {
      id: 'legacy',
      projectId: 'p1',
      name: 'Daily update',
      enabled: true,
      cadence: { kind: 'daily', time: '09:00' },
      template: { title: 'Update deps', description: 'Update all', tokenBudget: 1000 },
      createdAt: 0,
      updatedAt: 0,
      nextRunAt: 9 * 60 * 60_000,
      history: [],
    };
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, schedules: [legacy] }));
    const store = createScheduleFileStore(file);
    const loaded = store.getSchedule(legacy.id);
    expect(loaded).toStrictEqual(legacy);
    expect(loaded).not.toHaveProperty('missedRunPolicy');

    const skip: RecurringSchedule = { ...legacy, id: 'skip', missedRunPolicy: 'skip' };
    await store.insertSchedule(skip);
    expect(createScheduleFileStore(file).listSchedules()).toStrictEqual([legacy, skip]);

    // zeenha fork: an edit can switch the policy through the patch allowlist.
    expect(await store.updateSchedule(skip.id, () => ({ missedRunPolicy: 'catch_up' }))).toStrictEqual({
      ...skip,
      missedRunPolicy: 'catch_up',
    });
  });

  it('rejects duplicate inserts without replacing the stored record', async () => {
    const store = createScheduleFileStore(file);
    const first = await store.insertSchedule(make('a'));
    await expect(store.insertSchedule(make('a', 'p2'))).rejects.toThrow('Schedule already exists: a');
    expect(store.listSchedules()).toEqual([first]);
  });

  it('merges only allowlisted fields from the patch', async () => {
    const store = createScheduleFileStore(file);
    const first = await store.insertSchedule(make('a'));
    const update = vi.fn((current: Readonly<RecurringSchedule>) => ({
      name: `${current.name} updated`,
      id: 'new-id',
      projectId: 'p2',
      createdAt: 2,
    }));
    const expected = { ...first, name: 'Example updated' };
    expect(await store.updateSchedule('a', update)).toEqual(expected);
    expect(update).toHaveBeenCalledWith(first);
    expect(store.listSchedules()).toEqual([expected]);
  });

  it('deletes an existing schedule and skips updates and deletes for missing IDs', async () => {
    const store = createScheduleFileStore(file);
    const first = await store.insertSchedule(make('a'));
    const second = await store.insertSchedule(make('b'));
    expect(await store.deleteSchedule('a')).toEqual(first);
    const mutator = vi.fn(() => ({ name: 'missing' }));
    expect(await store.updateSchedule('a', mutator)).toBeUndefined();
    expect(await store.deleteSchedule('a')).toBeUndefined();
    expect(mutator).not.toHaveBeenCalled();
    expect(store.listSchedules()).toEqual([second]);
  });

  it('does not create the file when updating a missing ID', async () => {
    const store = createScheduleFileStore(file);
    const mutator = vi.fn(() => ({ name: 'missing' }));
    expect(await store.updateSchedule('a', mutator)).toBeUndefined();
    expect(mutator).not.toHaveBeenCalled();
    expect(() => readFileSync(file)).toThrow(/ENOENT/);
  });

  it('reads empty from a corrupt file', async () => {
    const store = createScheduleFileStore(file);
    await store.insertSchedule(make('a'));
    writeFileSync(file, '{not json');
    expect(store.listSchedules()).toEqual([]);
    expect(store.getSchedule('a')).toBeUndefined();
  });

  it('stores only the newest history records', async () => {
    const store = createScheduleFileStore(file);
    const history: ScheduleRunRecord[] = Array.from({ length: MAX_SCHEDULE_HISTORY + 5 }, (_, i) => ({
      id: `run-${i}`,
      at: i,
      kind: 'started',
      acknowledged: false,
    }));
    const saved = await store.insertSchedule(make('a', 'p1', history));
    expect(saved.history).toEqual(history.slice(5));
    expect(store.getSchedule('a')).toEqual(saved);
  });

  it('releases the lock without writing if an update callback throws', async () => {
    const store = createScheduleFileStore(file);
    const first = await store.insertSchedule(make('a'));
    await expect(store.updateSchedule('a', () => {
      throw new Error('update failed');
    })).rejects.toThrow('update failed');
    expect(existsSync(`${file}.lock`)).toBe(false);
    expect(store.getSchedule('a')).toEqual(first);
    await expect(store.updateSchedule('a', () => ({ name: 'Recovered' }))).resolves.toEqual({
      ...first,
      name: 'Recovered',
    });
  });

  it('retains changes to different rows from stores using equivalent paths', async () => {
    const direct = createScheduleFileStore(file);
    const lazy = createScheduleFileStore(() => path.relative(process.cwd(), file));
    const first = make('a');
    const second = make('b', 'p2');
    await Promise.all([direct.insertSchedule(first), lazy.insertSchedule(second)]);

    await Promise.all([
      direct.updateSchedule('a', () => ({ name: 'Renamed' })),
      lazy.updateSchedule('b', () => ({ enabled: false, nextRunAt: null })),
    ]);

    expect(direct.listSchedules('p1')).toEqual([{ ...first, name: 'Renamed' }]);
    expect(lazy.listSchedules('p2')).toEqual([{ ...second, enabled: false, nextRunAt: null }]);
  });

  it('serializes an overlapping update and delete and never rewrites for the deleted ID', async () => {
    const editor = createScheduleFileStore(file);
    const remover = createScheduleFileStore(() => file);
    const first = await editor.insertSchedule(make('a'));
    const second = await remover.insertSchedule(make('b'));
    const patch = { name: 'Renamed' };
    let deletion: ReturnType<typeof remover.deleteSchedule> | undefined;
    const updated = await editor.updateSchedule('a', () => {
      // Start deletion while the editor owns the lock, fixing the commit order.
      deletion = remover.deleteSchedule('a');
      return patch;
    });
    expect(updated).toEqual({ ...first, ...patch });
    expect(await deletion).toEqual(updated);

    // Use a known old mtime so even an identical rewrite is detectable.
    utimesSync(file, 1, 1);
    const before = statSync(file).mtimeMs;
    const staleUpdate = vi.fn(() => patch);
    expect(await editor.updateSchedule('a', staleUpdate)).toBeUndefined();
    expect(staleUpdate).not.toHaveBeenCalled();
    expect(statSync(file).mtimeMs).toBe(before);
    expect(editor.listSchedules()).toEqual([second]);
  });

  it('reads an external writer’s committed changes only after acquiring the filesystem lock', async () => {
    const store = createScheduleFileStore(file);
    const first = await store.insertSchedule(make('a'));
    const real = await vi.importActual<typeof lockfile>('proper-lockfile');
    const release: () => Promise<void> = await real.lock(file, { realpath: false });
    const committed = { ...first, name: 'External edit' };
    const mutator = vi.fn(() => ({ lastTaskId: 'task-1' }));
    let signalContention!: () => void;
    const contended = new Promise<void>((resolve) => {
      signalContention = resolve;
    });
    // Observe a real mkdir collision; the library still does all locking and retrying.
    vi.mocked(lockfile.lock).mockImplementationOnce((target: string, options: Record<string, unknown>) =>
      real.lock(target, {
        ...options,
        fs: {
          ...fs,
          mkdir(lockPath: string, callback: (err: NodeJS.ErrnoException | null) => void) {
            fs.mkdir(lockPath, (err) => {
              if (err?.code === 'EEXIST') signalContention();
              callback(err);
            });
          },
        },
      }),
    );
    const waiting = store.updateSchedule('a', mutator);
    try {
      const blocked = await Promise.race([contended.then(() => true), waiting.then(() => false)]);
      expect(blocked).toBe(true);
      expect(mutator).not.toHaveBeenCalled();
      writeFileSync(file, JSON.stringify({ version: 1, schedules: [committed] }));
    } finally {
      await release();
      await waiting;
    }
    expect(mutator).toHaveBeenCalledWith(committed);
    expect(store.getSchedule('a')).toEqual({ ...committed, lastTaskId: 'task-1' });
  });

  it('trims appended reports to the newest 50 and keeps retained acknowledgements', async () => {
    const store = createScheduleFileStore(file);
    const history: ScheduleRunRecord[] = Array.from({ length: MAX_SCHEDULE_HISTORY + 2 }, (_, i) => ({
      id: `report-${i}`,
      at: i,
      kind: 'failed',
      acknowledged: i % 2 === 0 && i < MAX_SCHEDULE_HISTORY,
    }));
    await store.insertSchedule(make('a', 'p1', history.slice(0, MAX_SCHEDULE_HISTORY)));
    const updated = await store.updateSchedule('a', (current) => ({
      history: [...current.history, ...history.slice(MAX_SCHEDULE_HISTORY)],
    }));
    expect(updated?.history).toEqual(history.slice(-50));
    expect(store.getSchedule('a')).toEqual(updated);
  });
});
