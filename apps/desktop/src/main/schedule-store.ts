/**
 * zeenha fork: persistent store for recurring task schedules, bound to
 * userData/schedules.json. The logic lives in schedule-file-store.ts.
 */
import { app } from 'electron';
import path from 'path';
import type { RecurringSchedule } from '../shared/types/schedule';
import { createScheduleFileStore, trimHistory as trimScheduleHistory } from './schedule-file-store';

// Resolved lazily so app.getPath is only called when the store is used.
const store = createScheduleFileStore(() => path.join(app.getPath('userData'), 'schedules.json'));

/** Keep only the newest MAX_SCHEDULE_HISTORY records. */
export function trimHistory(schedule: RecurringSchedule): RecurringSchedule {
  return trimScheduleHistory(schedule);
}

export function listSchedules(projectId?: string): RecurringSchedule[] {
  return store.listSchedules(projectId);
}

export function getSchedule(id: string): RecurringSchedule | undefined {
  return store.getSchedule(id);
}

/** Insert or replace by id. Returns the stored (history-trimmed) schedule. */
export function saveSchedule(schedule: RecurringSchedule): RecurringSchedule {
  return store.saveSchedule(schedule);
}

export function removeSchedule(id: string): boolean {
  return store.removeSchedule(id);
}
