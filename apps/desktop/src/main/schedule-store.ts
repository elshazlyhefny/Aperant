/**
 * zeenha fork: persistent store for recurring task schedules, bound to
 * userData/schedules.json. The logic lives in schedule-file-store.ts.
 */
import { app } from 'electron';
import path from 'path';
import type { RecurringSchedule } from '../shared/types/schedule';
import { createScheduleFileStore, type ScheduleGuard, type ScheduleMutator, trimHistory as trimScheduleHistory } from './schedule-file-store';

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

export function insertSchedule(schedule: RecurringSchedule): Promise<RecurringSchedule> {
  return store.insertSchedule(schedule);
}

export function updateSchedule(id: string, mutator: ScheduleMutator): Promise<RecurringSchedule | undefined> {
  return store.updateSchedule(id, mutator);
}

export function deleteSchedule(id: string, guard?: ScheduleGuard): Promise<RecurringSchedule | undefined> {
  return store.deleteSchedule(id, guard);
}
