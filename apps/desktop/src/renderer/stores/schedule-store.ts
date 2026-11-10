import { create } from 'zustand';
import type { RecurringSchedule, ScheduleInput, ScheduleRunRecord } from '../../shared/types/schedule';
import { debugLog } from '@shared/utils/debug-logger';

// zeenha fork: renderer state for recurring task schedules.

interface ScheduleState {
  schedules: RecurringSchedule[];
  activeProjectId: string | null;
  isLoading: boolean;
  error: string | null;

  loadSchedules: (projectId: string) => Promise<void>;
  createSchedule: (projectId: string, input: ScheduleInput) => Promise<RecurringSchedule | null>;
  updateSchedule: (id: string, input: ScheduleInput) => Promise<RecurringSchedule | null>;
  deleteSchedule: (id: string) => Promise<boolean>;
  setEnabled: (id: string, enabled: boolean) => Promise<boolean>;
  acknowledgeReports: (scheduleId: string, recordIds?: string[]) => Promise<boolean>;
}

function replaceSchedule(list: RecurringSchedule[], updated: RecurringSchedule): RecurringSchedule[] {
  return list.some((s) => s.id === updated.id)
    ? list.map((s) => (s.id === updated.id ? updated : s))
    : [...list, updated];
}

export const useScheduleStore = create<ScheduleState>((set, get) => ({
  schedules: [],
  activeProjectId: null,
  isLoading: false,
  error: null,

  loadSchedules: async (projectId) => {
    if (get().activeProjectId !== projectId) {
      set({ schedules: [], activeProjectId: projectId });
    }
    set({ isLoading: true, error: null });
    try {
      const result = await window.electronAPI.listSchedules(projectId);
      if (get().activeProjectId !== projectId) return;
      if (result.success && result.data) {
        set({ schedules: result.data, isLoading: false });
      } else {
        set({ error: result.error ?? 'Failed to load schedules', isLoading: false });
      }
    } catch (error) {
      debugLog('[ScheduleStore] Failed to load schedules:', error);
      set({ error: error instanceof Error ? error.message : String(error), isLoading: false });
    }
  },

  createSchedule: async (projectId, input) => {
    const result = await window.electronAPI.createSchedule(projectId, input);
    if (result.success && result.data) {
      const created = result.data;
      set((s) => ({ schedules: replaceSchedule(s.schedules, created), error: null }));
      return created;
    }
    set({ error: result.error ?? 'Failed to create schedule' });
    return null;
  },

  updateSchedule: async (id, input) => {
    const result = await window.electronAPI.updateSchedule(id, input);
    if (result.success && result.data) {
      const updated = result.data;
      set((s) => ({ schedules: replaceSchedule(s.schedules, updated), error: null }));
      return updated;
    }
    set({ error: result.error ?? 'Failed to update schedule' });
    return null;
  },

  deleteSchedule: async (id) => {
    const result = await window.electronAPI.deleteSchedule(id);
    if (result.success) {
      set((s) => ({ schedules: s.schedules.filter((x) => x.id !== id), error: null }));
      return true;
    }
    set({ error: result.error ?? 'Failed to delete schedule' });
    return false;
  },

  setEnabled: async (id, enabled) => {
    const result = await window.electronAPI.setScheduleEnabled(id, enabled);
    if (result.success && result.data) {
      const updated = result.data;
      set((s) => ({ schedules: replaceSchedule(s.schedules, updated), error: null }));
      return true;
    }
    set({ error: result.error ?? 'Failed to update schedule' });
    return false;
  },

  acknowledgeReports: async (scheduleId, recordIds) => {
    const result = await window.electronAPI.acknowledgeScheduleReports(scheduleId, recordIds);
    if (result.success && result.data) {
      const updated = result.data;
      set((s) => ({ schedules: replaceSchedule(s.schedules, updated), error: null }));
      return true;
    }
    set({ error: result.error ?? 'Failed to acknowledge reports' });
    return false;
  }
}));

/** Unacknowledged missed/skipped records of a schedule. */
export function getUnacknowledgedReports(schedule: RecurringSchedule): ScheduleRunRecord[] {
  return schedule.history.filter(
    (r) => !r.acknowledged && (r.kind === 'missed' || r.kind === 'skipped_unfinished')
  );
}

/** Total unacknowledged missed/skipped records across all schedules. */
export function countUnacknowledgedReports(schedules: RecurringSchedule[]): number {
  return schedules.reduce((sum, s) => sum + getUnacknowledgedReports(s).length, 0);
}

let unsubscribe: (() => void) | null = null;

/** Subscribe to main-process changes and reload for the active project. Returns an unsubscribe function. */
export function subscribeToScheduleChanges(): () => void {
  if (unsubscribe) return unsubscribe;
  const off = window.electronAPI.onSchedulesChanged((event) => {
    const { activeProjectId, loadSchedules } = useScheduleStore.getState();
    if (activeProjectId && activeProjectId === event.projectId) {
      void loadSchedules(activeProjectId);
    }
  });
  unsubscribe = () => {
    off();
    unsubscribe = null;
  };
  return unsubscribe;
}
