import { create } from 'zustand';
import type { TaskQueueState } from '../../shared/types/task-queue';
import { DEFAULT_MAX_PARALLEL_TASKS } from '../../shared/constants/queue';

interface TaskQueueStoreState {
  /** Main-process queue state keyed by project id */
  statesByProject: Record<string, TaskQueueState>;
  setState: (state: TaskQueueState) => void;
  loadState: (projectId: string) => Promise<void>;
}

export const useTaskQueueStore = create<TaskQueueStoreState>((set) => ({
  statesByProject: {},

  setState: (state) =>
    set((s) => ({ statesByProject: { ...s.statesByProject, [state.projectId]: state } })),

  loadState: async (projectId) => {
    try {
      const result = await window.electronAPI?.getTaskQueueState?.(projectId);
      if (result?.success && result.data) {
        set((s) => ({ statesByProject: { ...s.statesByProject, [projectId]: result.data as TaskQueueState } }));
      }
    } catch {
      // Keep fallback values until the next state event arrives
    }
  },
}));

/** Max parallel tasks for a project, falling back to the default before the first state arrives. */
export function getMaxParallelTasks(projectId: string): number {
  return useTaskQueueStore.getState().statesByProject[projectId]?.maxParallelTasks ?? DEFAULT_MAX_PARALLEL_TASKS;
}
