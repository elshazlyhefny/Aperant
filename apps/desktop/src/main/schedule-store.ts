/**
 * zeenha fork: persistent store for recurring task schedules. Kept in its own
 * file in userData (schedules.json). A missing or corrupt file reads as empty
 * (fail closed: nothing runs), and writes are atomic.
 */
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import { MAX_SCHEDULE_HISTORY, type RecurringSchedule } from '../shared/types/schedule';
import { writeFileAtomicSync } from './utils/atomic-file';

interface ScheduleFile {
  version: 1;
  schedules: RecurringSchedule[];
}

function getStorePath(): string {
  return path.join(app.getPath('userData'), 'schedules.json');
}

function isSchedule(value: unknown): value is RecurringSchedule {
  if (!value || typeof value !== 'object') return false;
  const s = value as Partial<RecurringSchedule>;
  return (
    typeof s.id === 'string' &&
    typeof s.projectId === 'string' &&
    !!s.cadence &&
    typeof s.cadence === 'object' &&
    !!s.template &&
    typeof s.template === 'object'
  );
}

function readFile(): ScheduleFile {
  const empty: ScheduleFile = { version: 1, schedules: [] };
  try {
    const storePath = getStorePath();
    if (!existsSync(storePath)) return empty;
    const parsed = JSON.parse(readFileSync(storePath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.schedules)) return empty;
    const schedules = (parsed.schedules as unknown[]).filter(isSchedule).map((s) => ({
      ...s,
      history: Array.isArray(s.history) ? s.history : [],
    }));
    return { version: 1, schedules };
  } catch {
    // Missing or corrupt: no schedules (fail closed)
    return empty;
  }
}

function writeFile(data: ScheduleFile): void {
  const storePath = getStorePath();
  mkdirSync(path.dirname(storePath), { recursive: true });
  writeFileAtomicSync(storePath, JSON.stringify(data, null, 2));
}

/** Keep only the newest MAX_SCHEDULE_HISTORY records. */
export function trimHistory(schedule: RecurringSchedule): RecurringSchedule {
  if (schedule.history.length <= MAX_SCHEDULE_HISTORY) return schedule;
  return { ...schedule, history: schedule.history.slice(-MAX_SCHEDULE_HISTORY) };
}

export function listSchedules(projectId?: string): RecurringSchedule[] {
  const all = readFile().schedules;
  return projectId ? all.filter((s) => s.projectId === projectId) : all;
}

export function getSchedule(id: string): RecurringSchedule | undefined {
  return readFile().schedules.find((s) => s.id === id);
}

/** Insert or replace by id. Returns the stored (history-trimmed) schedule. */
export function saveSchedule(schedule: RecurringSchedule): RecurringSchedule {
  const data = readFile();
  const trimmed = trimHistory(schedule);
  const index = data.schedules.findIndex((s) => s.id === trimmed.id);
  if (index >= 0) data.schedules[index] = trimmed;
  else data.schedules.push(trimmed);
  writeFile(data);
  return trimmed;
}

export function removeSchedule(id: string): boolean {
  const data = readFile();
  const next = data.schedules.filter((s) => s.id !== id);
  if (next.length === data.schedules.length) return false;
  writeFile({ version: 1, schedules: next });
  return true;
}
