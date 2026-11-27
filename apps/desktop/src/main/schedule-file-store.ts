/**
 * zeenha fork: Electron-free file store for recurring task schedules. A missing
 * or corrupt file reads as empty (fail closed: nothing runs), and writes are
 * locked and atomic. schedule-store.ts binds this to userData/schedules.json.
 */
import { existsSync, readFileSync } from 'fs';
import { mkdir } from 'fs/promises';
import path from 'path';
// @ts-expect-error - no types available for proper-lockfile
import * as lockfile from 'proper-lockfile';
import { MAX_SCHEDULE_HISTORY, type RecurringSchedule } from '../shared/types/schedule';
import { writeFileAtomicSync } from './utils/atomic-file';
import { withFileLock } from './utils/file-lock';

interface ScheduleFile {
  version: 1;
  schedules: RecurringSchedule[];
}

const MUTABLE_FIELDS = [
  'name',
  'enabled',
  'cadence',
  // zeenha fork: editing a schedule can change how it treats missed runs.
  'missedRunPolicy',
  'template',
  'updatedAt',
  'nextRunAt',
  'lastRunAt',
  'lastTaskId',
  'history',
] as const;

export type SchedulePatch = Partial<Pick<RecurringSchedule, (typeof MUTABLE_FIELDS)[number]>>;
export type ScheduleMutator = (current: Readonly<RecurringSchedule>) => SchedulePatch;
// zeenha fork: lets a caller check the stored record (e.g. its project) under the lock.
export type ScheduleGuard = (current: Readonly<RecurringSchedule>) => void;

export interface ScheduleFileStore {
  listSchedules(projectId?: string): RecurringSchedule[];
  getSchedule(id: string): RecurringSchedule | undefined;
  insertSchedule(schedule: RecurringSchedule): Promise<RecurringSchedule>;
  updateSchedule(id: string, mutator: ScheduleMutator): Promise<RecurringSchedule | undefined>;
  /** guard runs under the lock and may throw to abort the delete. */
  deleteSchedule(id: string, guard?: ScheduleGuard): Promise<RecurringSchedule | undefined>;
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

  function readFile(resolvedPath?: string): ScheduleFile {
    const empty: ScheduleFile = { version: 1, schedules: [] };
    try {
      const storePath = resolvedPath ?? getStorePath();
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

  /** A mutator returns undefined to skip the write (e.g. when the ID is absent). */
  async function mutate<T>(mutator: (data: ScheduleFile) => T): Promise<T> {
    const storePath = path.resolve(getStorePath());
    await mkdir(path.dirname(storePath), { recursive: true });
    return withFileLock(storePath, async () => {
      const release: () => Promise<void> = await lockfile.lock(storePath, {
        realpath: false,
        retries: { retries: 10, minTimeout: 50, maxTimeout: 500 },
      });
      try {
        const data = readFile(storePath);
        const result = mutator(data);
        if (result !== undefined) {
          writeFileAtomicSync(storePath, JSON.stringify(data, null, 2));
        }
        return result;
      } finally {
        try {
          await release();
        } catch {
          // The lock may already be gone. Preserve any mutation error.
        }
      }
    });
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
    insertSchedule(schedule) {
      return mutate((data) => {
        if (data.schedules.some((s) => s.id === schedule.id)) {
          throw new Error(`Schedule already exists: ${schedule.id}`);
        }
        const stored = trimHistory(schedule);
        data.schedules.push(stored);
        return stored;
      });
    },
    updateSchedule(id, mutator) {
      return mutate((data) => {
        const index = data.schedules.findIndex((s) => s.id === id);
        if (index < 0) return undefined;
        const current = data.schedules[index];
        // Only changes returned in the patch can affect the stored record.
        const patch = mutator(structuredClone(current));
        const updated = { ...current };
        for (const field of MUTABLE_FIELDS) {
          if (Object.hasOwn(patch, field)) Object.assign(updated, { [field]: patch[field] });
        }
        const stored = trimHistory(updated);
        data.schedules[index] = stored;
        return stored;
      });
    },
    deleteSchedule(id, guard) {
      return mutate((data) => {
        const removed = data.schedules.find((s) => s.id === id);
        if (!removed) return undefined;
        guard?.(structuredClone(removed));
        data.schedules = data.schedules.filter((s) => s.id !== id);
        return removed;
      });
    },
  };
}
