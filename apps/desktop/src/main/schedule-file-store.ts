/**
 * zeenha fork: Electron-free file store for recurring task schedules. A missing
 * or corrupt file reads as empty (fail closed: nothing runs), and writes are
 * atomic. schedule-store.ts binds this to userData/schedules.json.
 */
import { existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import { MAX_SCHEDULE_HISTORY, type RecurringSchedule } from '../shared/types/schedule';
import { writeFileAtomicSync } from './utils/atomic-file';

interface ScheduleFile {
  version: 1;
  schedules: RecurringSchedule[];
}

export interface ScheduleFileStore {
  listSchedules(projectId?: string): RecurringSchedule[];
  getSchedule(id: string): RecurringSchedule | undefined;
  saveSchedule(schedule: RecurringSchedule): RecurringSchedule;
  removeSchedule(id: string): boolean;
  trimHistory(schedule: RecurringSchedule): RecurringSchedule;
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

/** Keep only the newest MAX_SCHEDULE_HISTORY records. */
export function trimHistory(schedule: RecurringSchedule): RecurringSchedule {
  if (schedule.history.length <= MAX_SCHEDULE_HISTORY) return schedule;
  return { ...schedule, history: schedule.history.slice(-MAX_SCHEDULE_HISTORY) };
}

export function createScheduleFileStore(filePath: string | (() => string)): ScheduleFileStore {
  const getStorePath = (): string => (typeof filePath === 'function' ? filePath() : filePath);

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

  return {
    trimHistory,
    listSchedules(projectId?: string): RecurringSchedule[] {
      const all = readFile().schedules;
      return projectId ? all.filter((s) => s.projectId === projectId) : all;
    },
    getSchedule(id: string): RecurringSchedule | undefined {
      return readFile().schedules.find((s) => s.id === id);
    },
    /** Insert or replace by id. Returns the stored (history-trimmed) schedule. */
    saveSchedule(schedule: RecurringSchedule): RecurringSchedule {
      const data = readFile();
      const trimmed = trimHistory(schedule);
      const index = data.schedules.findIndex((x) => x.id === trimmed.id);
      if (index >= 0) data.schedules[index] = trimmed;
      else data.schedules.push(trimmed);
      writeFile(data);
      return trimmed;
    },
    removeSchedule(id: string): boolean {
      const data = readFile();
      const next = data.schedules.filter((x) => x.id !== id);
      if (next.length === data.schedules.length) return false;
      writeFile({ version: 1, schedules: next });
      return true;
    },
  };
}
