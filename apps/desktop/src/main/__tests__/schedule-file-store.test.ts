import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SCHEDULE_HISTORY, type RecurringSchedule } from '../../shared/types/schedule';
import { createScheduleFileStore } from '../schedule-file-store';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sched-store-'));
  file = path.join(dir, 'nested', 'schedules.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function make(id: string, projectId = 'p1', history: unknown[] = []): RecurringSchedule {
  return { id, projectId, cadence: { type: 'daily' }, template: { title: 't' }, history } as unknown as RecurringSchedule;
}

describe('createScheduleFileStore', () => {
  it('round trips save, get, list, remove', () => {
    const store = createScheduleFileStore(file);
    expect(store.listSchedules()).toEqual([]);
    store.saveSchedule(make('a'));
    store.saveSchedule(make('b', 'p2'));
    expect(store.getSchedule('a')?.id).toBe('a');
    expect(store.listSchedules('p2').map((s) => s.id)).toEqual(['b']);
    expect(store.removeSchedule('a')).toBe(true);
    expect(store.removeSchedule('a')).toBe(false);
    expect(store.listSchedules().map((s) => s.id)).toEqual(['b']);
  });

  it('reads empty from a corrupt file', () => {
    const store = createScheduleFileStore(file);
    store.saveSchedule(make('a'));
    writeFileSync(file, '{not json');
    expect(store.listSchedules()).toEqual([]);
  });

  it('trims history to the newest records', () => {
    const store = createScheduleFileStore(file);
    const history = Array.from({ length: MAX_SCHEDULE_HISTORY + 5 }, (_, i) => ({ n: i }));
    const saved = store.saveSchedule(make('a', 'p1', history));
    expect(saved.history).toHaveLength(MAX_SCHEDULE_HISTORY);
    expect((saved.history[saved.history.length - 1] as unknown as { n: number }).n).toBe(MAX_SCHEDULE_HISTORY + 4);
  });
});

describe('updateExistingSchedule', () => {
  it('applies the update to the latest persisted schedule', () => {
    const store = createScheduleFileStore(file);
    const original = store.saveSchedule({ ...make('a'), name: 'original' });
    const edited = store.saveSchedule({ ...original, name: 'edited' });
    const update = vi.fn((current: RecurringSchedule) => ({ ...current, lastTaskId: 't1' }));

    const result = store.updateExistingSchedule('a', update);

    expect(update).toHaveBeenCalledExactlyOnceWith(edited);
    expect(result).toEqual({ ...edited, lastTaskId: 't1' });
    expect(store.getSchedule('a')).toEqual(result);
  });

  it('does not write or invoke the update for a missing or deleted schedule', () => {
    const store = createScheduleFileStore(file);
    const update = vi.fn((current: RecurringSchedule) => current);

    expect(store.updateExistingSchedule('a', update)).toBeUndefined();
    expect(() => readFileSync(file)).toThrow(/ENOENT/);

    store.saveSchedule(make('a'));
    const other = store.saveSchedule(make('b'));
    expect(store.removeSchedule('a')).toBe(true);
    // A rewrite would remove the extra newline even if the records did not change.
    const before = `${readFileSync(file, 'utf-8')}\n`;
    writeFileSync(file, before);

    expect(store.updateExistingSchedule('a', update)).toBeUndefined();
    expect(update).not.toHaveBeenCalled();
    expect(readFileSync(file, 'utf-8')).toBe(before);
    expect(store.listSchedules()).toEqual([other]);
  });

  it('trims history to the newest records after the update appends', () => {
    const store = createScheduleFileStore(file);
    const history = Array.from({ length: MAX_SCHEDULE_HISTORY + 1 }, (_, i) => ({
      id: `run-${i}`,
      at: i,
      kind: 'started' as const,
      acknowledged: false,
    }));
    store.saveSchedule(make('a', 'p1', history.slice(0, -1)));

    const result = store.updateExistingSchedule('a', (current) => ({
      ...current,
      history: [...current.history, history[history.length - 1]],
    }));

    expect(result?.history).toEqual(history.slice(1));
    expect(store.getSchedule('a')).toEqual(result);
  });

  it('keeps the original id and position when the update returns a different id', () => {
    const store = createScheduleFileStore(file);
    const original = store.saveSchedule(make('a'));
    const other = store.saveSchedule(make('b'));

    const result = store.updateExistingSchedule('a', (current) => ({
      ...current,
      id: 'b',
      lastTaskId: 't1',
    }));

    expect(result).toEqual({ ...original, lastTaskId: 't1' });
    expect(store.listSchedules()).toEqual([result, other]);
  });

  it('returns the current record without writing when the update returns undefined', () => {
    const store = createScheduleFileStore(file);
    const original = store.saveSchedule(make('a'));
    const before = `${readFileSync(file, 'utf-8')}\n`;
    writeFileSync(file, before);
    const update = vi.fn(() => undefined);

    expect(store.updateExistingSchedule('a', update)).toEqual(original);
    expect(update).toHaveBeenCalledExactlyOnceWith(original);
    expect(readFileSync(file, 'utf-8')).toBe(before);
  });
});
