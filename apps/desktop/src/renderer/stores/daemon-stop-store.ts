import { create } from 'zustand';

// zeenha fork: tracks in-flight "stop a daemon-run task" requests and their failures.
interface DaemonStopStoreState {
  pendingByTask: Record<string, true>;
  /** Failure reason code per task, mapped to a translated message by the UI */
  errorByTask: Record<string, string>;
  requestStop: (taskId: string) => Promise<void>;
  setFailed: (taskId: string, reason: string) => void;
  clear: (taskId: string) => void;
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const { [key]: _removed, ...rest } = record;
  return rest;
}

export const useDaemonStopStore = create<DaemonStopStoreState>((set, get) => ({
  pendingByTask: {},
  errorByTask: {},

  requestStop: async (taskId) => {
    if (get().pendingByTask[taskId]) return;
    set((s) => ({
      errorByTask: without(s.errorByTask, taskId),
      pendingByTask: { ...s.pendingByTask, [taskId]: true },
    }));
    try {
      const result = await window.electronAPI?.daemonStopTask?.(taskId);
      if (result && !result.success) {
        get().setFailed(taskId, result.error ?? 'unknown');
      }
    } catch {
      get().setFailed(taskId, 'unknown');
    }
  },

  setFailed: (taskId, reason) =>
    set((s) => ({
      pendingByTask: without(s.pendingByTask, taskId),
      errorByTask: { ...s.errorByTask, [taskId]: reason },
    })),

  clear: (taskId) =>
    set((s) => ({
      pendingByTask: without(s.pendingByTask, taskId),
      errorByTask: without(s.errorByTask, taskId),
    })),
}));
