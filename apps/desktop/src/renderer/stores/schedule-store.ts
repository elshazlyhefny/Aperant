import { create } from 'zustand';
import type {
  RecurringSchedule,
  ScheduleInput,
  ScheduleRunNowResult,
  ScheduleRunRecord
} from '../../shared/types/schedule';
import { debugLog } from '@shared/utils/debug-logger';

// zeenha fork: renderer state for recurring task schedules.

interface ScheduleState {
  schedules: RecurringSchedule[];
  activeProjectId: string | null;
  isLoading: boolean;
  error: string | null;
  loadError: string | null;

  loadSchedules: (projectId: string) => Promise<void>;
  createSchedule: (projectId: string, input: ScheduleInput) => Promise<RecurringSchedule | null>;
  updateSchedule: (id: string, input: ScheduleInput) => Promise<RecurringSchedule | null>;
  deleteSchedule: (id: string) => Promise<boolean>;
  setEnabled: (id: string, enabled: boolean) => Promise<boolean>;
  acknowledgeReports: (scheduleId: string, recordIds?: string[]) => Promise<boolean>;
  runNow: (id: string) => Promise<ScheduleRunNowResult | null>;
}

function replaceSchedule(list: RecurringSchedule[], updated: RecurringSchedule): RecurringSchedule[] {
  return list.some((s) => s.id === updated.id)
    ? list.map((s) => (s.id === updated.id ? updated : s))
    : [...list, updated];
}

// zeenha fork: activation distinguishes A -> B -> A switches; the load ID
// also orders overlapping requests within the same activation.
let activeGeneration = 0;
let latestLoadId = 0;

function activate(projectId: string, currentProjectId: string | null) {
  if (currentProjectId === projectId) return;
  ++activeGeneration;
  return { schedules: [], activeProjectId: projectId };
}

function invalidateScheduleLoads(): number {
  return ++latestLoadId;
}

type CurrentOwner = () => string | null;

// zeenha fork: a mutation can write only to the project activation that started it.
function captureOwner(projectId: string | null): CurrentOwner {
  const activation = activeGeneration;
  const owner = useScheduleStore.getState().activeProjectId === projectId ? projectId : null;
  return () =>
    activation === activeGeneration && useScheduleStore.getState().activeProjectId === owner
      ? owner
      : null;
}

function commitMutation(
  currentOwner: CurrentOwner,
  updateSchedules: (list: RecurringSchedule[], projectId: string) => RecurringSchedule[]
): void {
  const projectId = currentOwner();
  if (projectId === null) return;

  useScheduleStore.setState(({ schedules }) => ({
    schedules: updateSchedules(schedules, projectId),
    error: null
  }));

  // A fresh load supersedes any pending pre-mutation snapshot. Recheck ownership
  // after the write since Zustand notifies subscribers synchronously.
  const { isLoading, loadSchedules } = useScheduleStore.getState();
  if (isLoading && currentOwner() !== null) void loadSchedules(projectId);
}

function commitSchedule(currentOwner: CurrentOwner, schedule: RecurringSchedule): void {
  commitMutation(currentOwner, (list, projectId) =>
    schedule.projectId === projectId ? replaceSchedule(list, schedule) : list
  );
}

export const useScheduleStore = create<ScheduleState>((set, get) => ({
  schedules: [],
  activeProjectId: null,
  isLoading: false,
  error: null,
  loadError: null,
  loadSchedules: async (projectId) => {
    const projectChange = activate(projectId, get().activeProjectId);
    const activation = activeGeneration;
    const requestId = invalidateScheduleLoads();
    const canCommit = () =>
      requestId === latestLoadId &&
      activation === activeGeneration &&
      get().activeProjectId === projectId;

    set({ ...projectChange, isLoading: true, error: null, loadError: null });
    try {
      const result = await window.electronAPI.listSchedules(projectId);
      if (!canCommit()) return;
      if (result.success && result.data) {
        set({ schedules: result.data, isLoading: false, loadError: null });
      } else {
        const message = result.error ?? 'Failed to load schedules';
        set({ error: message, loadError: message, isLoading: false });
      }
    } catch (error) {
      debugLog('[ScheduleStore] Failed to load schedules:', error);
      if (!canCommit()) return;
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message, loadError: message, isLoading: false });
    }
  },

  createSchedule: async (projectId, input) => {
    const currentOwner = captureOwner(projectId);
    const result = await window.electronAPI.createSchedule(projectId, input);
    if (result.success && result.data) {
      commitSchedule(currentOwner, result.data);
      return result.data;
    }
    if (currentOwner() !== null) set({ error: result.error ?? 'Failed to create schedule' });
    return null;
  },

  // zeenha fork: by-ID calls pass the active project so main can reject a
  // schedule that belongs to another project. Without one nothing is sent.
  updateSchedule: async (id, input) => {
    const projectId = get().activeProjectId;
    if (projectId === null) return null;
    const currentOwner = captureOwner(projectId);
    const result = await window.electronAPI.updateSchedule(projectId, id, input);
    if (result.success && result.data) {
      commitSchedule(currentOwner, result.data);
      return result.data;
    }
    if (currentOwner() !== null) set({ error: result.error ?? 'Failed to update schedule' });
    return null;
  },

  deleteSchedule: async (id) => {
    const projectId = get().activeProjectId;
    if (projectId === null) return false;
    const currentOwner = captureOwner(projectId);
    const result = await window.electronAPI.deleteSchedule(projectId, id);
    if (result.success) {
      commitMutation(currentOwner, (list) => list.filter((schedule) => schedule.id !== id));
      return true;
    }
    if (currentOwner() !== null) set({ error: result.error ?? 'Failed to delete schedule' });
    return false;
  },

  setEnabled: async (id, enabled) => {
    const projectId = get().activeProjectId;
    if (projectId === null) return false;
    const currentOwner = captureOwner(projectId);
    const result = await window.electronAPI.setScheduleEnabled(projectId, id, enabled);
    if (result.success && result.data) {
      commitSchedule(currentOwner, result.data);
      return true;
    }
    if (currentOwner() !== null) set({ error: result.error ?? 'Failed to update schedule' });
    return false;
  },

  acknowledgeReports: async (scheduleId, recordIds) => {
    const projectId = get().activeProjectId;
    if (projectId === null) return false;
    const currentOwner = captureOwner(projectId);
    const result = await window.electronAPI.acknowledgeScheduleReports(projectId, scheduleId, recordIds);
    if (result.success && result.data) {
      commitSchedule(currentOwner, result.data);
      return true;
    }
    if (currentOwner() !== null) set({ error: result.error ?? 'Failed to acknowledge reports' });
    return false;
  },

  runNow: async (id) => {
    const requestProjectId = get().activeProjectId;
    if (requestProjectId === null) return null;
    const currentOwner = captureOwner(requestProjectId);
    const result = await window.electronAPI.runScheduleNow(requestProjectId, id);
    const projectId = currentOwner();
    if (result.success && result.data) {
      // The reload also clears the current project's action error.
      if (projectId !== null) void get().loadSchedules(projectId);
      return result.data;
    }
    if (projectId !== null) set({ error: result.error ?? 'Failed to run schedule' });
    return null;
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
