import { create } from 'zustand';

/** Maximum log entries stored per task to prevent renderer OOM */
export const MAX_LOG_ENTRIES = 5000;

/** Stable empty array so selectors never return a fresh [] (avoids render loops). */
const EMPTY_LOGS: readonly string[] = Object.freeze([]) as readonly string[];

/**
 * zeenha fork: agent log lines live in their own store instead of on each Task in
 * useTaskStore.tasks. Appending a log used to replace the tasks array, which re-rendered
 * every subscriber of the tasks list (kanban board, cards) on every log flush. Keeping
 * logs here means a log flush only notifies components that read logs.
 * This store is intentionally independent of useTaskStore.
 */
interface TaskLogsState {
  logsByTaskId: Record<string, string[]>;

  appendLogs: (taskId: string, lines: string[]) => void;
  seedLogs: (taskId: string, lines: string[]) => void;
  clearLogs: (taskIds?: string[]) => void;
  clearAllLogs: () => void;
  pruneLogs: (keepIds: Set<string>) => void;
}

export const useTaskLogsStore = create<TaskLogsState>((set) => ({
  logsByTaskId: {},

  appendLogs: (taskId, lines) =>
    set((state) => {
      if (lines.length === 0) return state;
      const current = state.logsByTaskId[taskId] ?? [];
      return {
        logsByTaskId: {
          ...state.logsByTaskId,
          [taskId]: [...current, ...lines].slice(-MAX_LOG_ENTRIES)
        }
      };
    }),

  seedLogs: (taskId, lines) =>
    set((state) => ({
      logsByTaskId: {
        ...state.logsByTaskId,
        [taskId]: lines.slice(-MAX_LOG_ENTRIES)
      }
    })),

  clearLogs: (taskIds) =>
    set((state) => {
      if (!taskIds) return { logsByTaskId: {} };
      const toClear = taskIds.filter((id) => id in state.logsByTaskId);
      if (toClear.length === 0) return state;
      const next = { ...state.logsByTaskId };
      for (const id of toClear) delete next[id];
      return { logsByTaskId: next };
    }),

  clearAllLogs: () =>
    set((state) => (Object.keys(state.logsByTaskId).length === 0 ? state : { logsByTaskId: {} })),

  pruneLogs: (keepIds) =>
    set((state) => {
      const stale = Object.keys(state.logsByTaskId).filter((id) => !keepIds.has(id));
      if (stale.length === 0) return state;
      const next = { ...state.logsByTaskId };
      for (const id of stale) delete next[id];
      return { logsByTaskId: next };
    })
}));

/** Selector factory returning a stable reference for tasks with no logs. */
export const selectTaskLogs =
  (taskId: string) =>
  (state: TaskLogsState): string[] =>
    state.logsByTaskId[taskId] ?? (EMPTY_LOGS as string[]);
