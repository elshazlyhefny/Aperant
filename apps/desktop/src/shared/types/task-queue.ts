/** Queue state for one project, sent from the main-process task queue manager. */
export interface TaskQueueState {
  projectId: string;
  maxParallelTasks: number;
  inProgressCount: number;
  /** Queued task ids, oldest first */
  queuedTaskIds: string[];
  /** Task ids skipped in the last pass because promotion failed */
  skippedTaskIds: string[];
  /** Set when another process (the daemon) runs this project's queue, so the desktop does not promote */
  lockedBy?: string;
  /** zeenha fork: ids the daemon reports running; only set together with lockedBy */
  lockedTaskIds?: string[];
}

/** zeenha fork: main -> renderer outcome of a daemon stop request that did not take effect. */
export interface DaemonStopResultEvent {
  taskId: string;
  projectId: string;
  state: 'failed';
  reason: 'daemon-released' | 'timeout' | 'not-running-on-daemon' | 'no-daemon' | 'invalid-task';
}
