import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
